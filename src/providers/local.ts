/**
 * Local AstraMemory provider.
 *
 * Implements MemoryProvider against the local daemon running at
 * http://127.0.0.1:7777 (or config.local.url / MEMORY_API_URL_LOCAL).
 *
 * Bearer is read from src/lib/secrets.ts — synchronous reader that parses
 * `<unifiedConfigDir()>/secrets.env` (populated by astramem-local) with
 * MEMORY_BEARER env-var fallback.
 *
 * Wire mapping (FEAT-532 — canonical adoption): recall() sends the canonical
 * astramem-retrieval-query@1 envelope {text,mode,limit,filters:{repo,project,
 * agent}} (ADR-005; @astragenie/astramem-contracts) — the daemon's POST
 * /recall already accepts the canonical text/limit/filters.* aliases
 * (src/server/routes/search.ts RecallBodySchema, #112 AC-2). `repo` is a
 * local-only filters extension beyond the published retrieval-query.v1
 * schema (RepoFilterSchema, FEAT-429) — cloud has no equivalent. The
 * response is parsed with the canonical astramem-retrieval-result@1 envelope
 * (RetrievalResultV1Schema); the daemon's /recall RESPONSE side is being
 * wired separately (FEAT-532 slice L1) — until that lands this parse targets
 * the future shape, not what the daemon returns today.
 *
 * Timeouts:
 *   ingest  — 2 s (fire-and-forget; retries 1× on 5xx / network error)
 *   recall  — 5 s
 *   remember — 5 s
 *   health  — 3 s
 *
 * Error mapping:
 *   4xx → DeterministicError (do not retry)
 *   5xx / network → TransientError (retry once for ingest; throw for recall/remember/health)
 */

import type { MemoryProvider } from '../contracts/provider.ts';
import type {
  IngestPayload,
  RecallRequest,
  RecallResponse,
  RecallHit,
  HealthResponse,
  TranscriptIngestPayload,
} from '../contracts/wire.ts';
import { RecallResponseSchema, HealthResponseSchema } from '../contracts/wire.ts';
import { RetrievalResultV1Schema, type RetrievalQueryV1, type RetrievalResultV1 } from '@astragenie/astramem-contracts/zod';
import { DeterministicError, TransientError } from '../lib/errors.ts';
import { readLocalBearer } from '../lib/secrets.ts';
import { resolveEnv } from '../lib/env.ts';
import { ENV } from '../lib/env-specs.ts';
import { scrubWithLabels } from '../lib/scrub.ts';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const DEFAULT_LOCAL_URL = 'http://127.0.0.1:7777';

function resolveBaseUrl(): string {
  return resolveEnv(ENV.apiUrlLocal).value ?? DEFAULT_LOCAL_URL;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch with an AbortController timeout. Throws TransientError on network
 * failures and timeout; throws DeterministicError on 4xx.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return res;
  } catch (err: unknown) {
    if ((err as Error)?.name === 'AbortError') {
      throw new TransientError(`Request timed out after ${timeoutMs}ms`, undefined, err);
    }
    throw new TransientError(`Network error: ${(err as Error)?.message ?? String(err)}`, undefined, err);
  } finally {
    clearTimeout(timer);
  }
}

/** Build common headers (Authorization never logged — scrub applied upstream). */
async function buildHeaders(): Promise<Record<string, string>> {
  const bearer = readLocalBearer();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (bearer) {
    headers['Authorization'] = `Bearer ${bearer}`;
  }
  return headers;
}

/**
 * Assert a response is OK.  4xx → DeterministicError; 5xx → TransientError.
 * Does NOT log the response body (may contain bearer echoes on some servers).
 */
async function assertOk(res: Response, context: string): Promise<void> {
  if (res.ok) return;
  const statusText = res.statusText || String(res.status);
  if (res.status >= 400 && res.status < 500) {
    throw new DeterministicError(
      `${context}: ${res.status} ${statusText}`,
      res.status,
    );
  }
  throw new TransientError(
    `${context}: ${res.status} ${statusText}`,
    res.status,
  );
}

// ---------------------------------------------------------------------------
// Canonical retrieval mapping (FEAT-532 — ADR-005 astramem-retrieval@1).
// This provider builds the canonical request and parses the canonical
// response, then maps down to the plugin's unified RecallRequest/RecallResponse
// (contracts/wire.ts), which stays the plugin's stable public shape.
// ---------------------------------------------------------------------------

/**
 * Build the canonical astramem-retrieval-query@1 body from the plugin's
 * unified RecallRequest. `repo` is forwarded inside `filters` — the daemon's
 * RecallBodySchema accepts it as a local-only extension of the published
 * canonical schema (FEAT-429 RepoFilterSchema); omitted entirely when no
 * filter is set so an unscoped recall stays a minimal body.
 */
function buildCanonicalRecallBody(req: RecallRequest): Record<string, unknown> {
  const core: RetrievalQueryV1 = {
    text: req.query,
    mode: 'hybrid',
    limit: req.k,
  };
  const filters: NonNullable<RetrievalQueryV1['filters']> & { repo?: string } = {};
  if (req.repo !== undefined) filters.repo = req.repo;
  if (req.project !== undefined) filters.project = req.project;
  if (req.agent !== undefined) filters.agent = req.agent;
  return {
    ...core,
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
  };
}

/** Map one astramem-retrieval-result@1 hit down to the plugin's unified RecallHit. */
function mapCanonicalHit(hit: RetrievalResultV1['hits'][number]): RecallHit {
  return {
    id: hit.id,
    type: hit.type,
    text: hit.text,
    score: clamp01(hit.score),
    ...(hit.source != null ? { source: hit.source } : {}),
    ...(hit.importance !== undefined ? { importance: clamp01(hit.importance) } : {}),
    ...(hit.confidence !== undefined ? { confidence: clamp01(hit.confidence) } : {}),
  };
}

/** Clamp to the RecallHit score domain [0,1] — the fused score should already
 * be in-domain, but a rerank/preset path may perturb it. */
function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class LocalProvider implements MemoryProvider {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? resolveBaseUrl()).replace(/\/$/, '');
  }

  /**
   * Fire-and-forget ingest.  Retries once on TransientError within the 2s budget.
   * Never propagates errors — caller is insulated per the contract.
   */
  async ingest(payload: IngestPayload): Promise<void> {
    const attemptIngest = async (): Promise<void> => {
      const headers = await buildHeaders();
      const res = await fetchWithTimeout(
        `${this.baseUrl}/ingest/transcript`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        },
        2000,
      );
      await assertOk(res, 'ingest');
    };

    try {
      await attemptIngest();
    } catch (err: unknown) {
      if (err instanceof TransientError) {
        // Retry once on transient failure.
        try {
          await attemptIngest();
        } catch {
          // Silently absorb — ingest is fire-and-forget.
        }
        return;
      }
      // DeterministicError also absorbed for fire-and-forget.
    }
  }

  /**
   * Fire-and-forget transcript ingest (FEAT 4a §4.1.1 Option B).
   * Posts a TranscriptIngestPayload to /ingest/transcript.
   * Applies a scrub pass on turn text before POSTing (defense-in-depth: protects
   * programmatic callers that bypass the CLI scrub layer). If the payload already
   * carries client_scrub_applied=true, the scrub is still applied — scrubWithLabels
   * is idempotent (second pass on an already-redacted string is a no-op).
   * Retries once on TransientError within the 2s budget.
   * Never propagates errors — caller is insulated per fire-and-forget contract.
   */
  async ingestTranscript(payload: TranscriptIngestPayload): Promise<void> {
    // Defense-in-depth scrub: run scrubWithLabels on each turn's text before
    // sending to the wire. CLI callers already scrubbed (idempotent). Programmatic
    // callers (MCP, SDK) that skipped the CLI layer get scrub here.
    let totalHits = payload.client_scrub_hits;
    const mergedHitsByLabel: Record<string, number> = { ...(payload.client_scrub_hits_by_label ?? {}) };
    const scrubbedTurns = payload.turns.map((turn) => {
      const { output, hitsByLabel } = scrubWithLabels(turn.text);
      for (const [label, count] of Object.entries(hitsByLabel)) {
        mergedHitsByLabel[label] = (mergedHitsByLabel[label] ?? 0) + count;
        // Trust caller's prior counts; this layer ADDS scrubber output for any text the
        // caller missed. Sum may exceed actual redactions if caller mis-counted upstream.
        totalHits += count;
      }
      return { ...turn, text: output };
    });
    const scrubbedPayload: TranscriptIngestPayload = {
      ...payload,
      turns: scrubbedTurns,
      client_scrub_applied: true,
      client_scrub_hits: totalHits,
      client_scrub_hits_by_label: mergedHitsByLabel,
    };

    const attemptIngestTranscript = async (): Promise<void> => {
      const headers = await buildHeaders();
      const res = await fetchWithTimeout(
        `${this.baseUrl}/ingest/transcript`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(scrubbedPayload),
        },
        2000,
      );
      await assertOk(res, 'ingest/transcript');
    };

    try {
      await attemptIngestTranscript();
    } catch (err: unknown) {
      if (err instanceof TransientError) {
        // Retry once on transient failure.
        try {
          await attemptIngestTranscript();
        } catch {
          // Silently absorb — ingest is fire-and-forget.
        }
        return;
      }
      // DeterministicError also absorbed for fire-and-forget.
    }
  }

  async recall(req: RecallRequest): Promise<RecallResponse> {
    const headers = await buildHeaders();
    const body = buildCanonicalRecallBody(req);
    const res = await fetchWithTimeout(
      `${this.baseUrl}/recall`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
      5000,
    );
    await assertOk(res, 'recall');
    const json: unknown = await res.json();
    const canonical = RetrievalResultV1Schema.parse(json);
    // Map astramem-retrieval-result@1 → unified RecallResponse.
    const mapped: RecallResponse = {
      hits: canonical.hits.map(mapCanonicalHit),
      total_searched: canonical.total,
      provider: 'local',
    };
    return RecallResponseSchema.parse(mapped);
  }

  async remember(req: IngestPayload): Promise<void> {
    const headers = await buildHeaders();
    const res = await fetchWithTimeout(
      `${this.baseUrl}/remember`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
      },
      5000,
    );
    await assertOk(res, 'remember');
  }

  async health(): Promise<HealthResponse> {
    const t0 = Date.now();
    const headers = await buildHeaders();
    const res = await fetchWithTimeout(
      `${this.baseUrl}/health`,
      { method: 'GET', headers },
      3000,
    );
    const latencyMs = Date.now() - t0;
    await assertOk(res, 'health');
    const json: unknown = await res.json();
    const parsed = HealthResponseSchema.parse(json);
    return { ...parsed, url: this.baseUrl, latencyMs };
  }
}

/** Factory — creates a LocalProvider with optional URL override from config. */
export function createLocalProvider(opts?: { url?: string }): LocalProvider {
  return new LocalProvider(opts?.url);
}
