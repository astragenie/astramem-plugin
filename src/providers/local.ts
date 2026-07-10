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

import type { MemoryProvider, ProviderCapabilities } from '../contracts/provider.ts';
import type {
  IngestPayload,
  RecallRequest,
  RecallResponse,
  HealthResponse,
  TranscriptIngestPayload,
} from '../contracts/wire.ts';
import { RecallResponseSchema, HealthResponseSchema, LocalAtomTypeSchema, LOCAL_ATOM_TYPES } from '../contracts/wire.ts';
import { DeterministicError, TransientError } from '../lib/errors.ts';
import { readLocalBearer } from '../lib/secrets.ts';
import { resolveEnv } from '../lib/env.ts';
import { ENV } from '../lib/env-specs.ts';
import { scrubWithLabels } from '../lib/scrub.ts';
import { unrefTimer, linkSignals } from '../lib/abort.ts';
import { mapRecallRequestToLocalFilters } from '../lib/wire-mapping.ts';

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
 *
 * The internal deadline timer is unref()'d (issue #29) so an abandoned fetch
 * left running after a caller's own shorter deadline fires cannot keep the
 * event loop alive on its own. An optional externalSignal is combined with
 * the internal deadline — whichever aborts first wins, and the error message
 * distinguishes a caller-initiated abort from an internal timeout.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  unrefTimer(timer);
  const { signal: combinedSignal, dispose } = linkSignals([ctrl.signal, externalSignal]);
  try {
    const res = await fetch(url, { ...init, signal: combinedSignal });
    return res;
  } catch (err: unknown) {
    if ((err as Error)?.name === 'AbortError') {
      if (externalSignal?.aborted) {
        throw new TransientError('Request aborted by caller signal', undefined, err);
      }
      throw new TransientError(`Request timed out after ${timeoutMs}ms`, undefined, err);
    }
    throw new TransientError(`Network error: ${(err as Error)?.message ?? String(err)}`, undefined, err);
  } finally {
    clearTimeout(timer);
    dispose();
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
// Provider implementation
// ---------------------------------------------------------------------------

export class LocalProvider implements MemoryProvider {
  private readonly baseUrl: string;

  /** Local daemon is single-tenant on this machine; as_of and per-signal
   *  explanation aren't wired through the wire contract yet — see
   *  ProviderCapabilities doc. The daemon internally fuses bm25/cosine/
   *  importance/freshness (astramem-local src/search/fuse.ts) but
   *  RecallHitSchema doesn't surface a per-hit explanation yet, so
   *  explainSignals stays empty until that field exists on the wire. */
  readonly capabilities: ProviderCapabilities = {
    tenancy: 'single',
    asOf: false,
    explainSignals: [],
  };

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? resolveBaseUrl()).replace(/\/$/, '');
  }

  /**
   * Fire-and-forget ingest.  Retries once on TransientError within the 2s budget.
   * Never propagates errors — caller is insulated per the contract.
   */
  async ingest(payload: IngestPayload, signal?: AbortSignal): Promise<void> {
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
        signal,
      );
      await assertOk(res, 'ingest');
    };

    try {
      await attemptIngest();
    } catch (err: unknown) {
      if (err instanceof TransientError) {
        // Caller already gave up (issue #29 review finding #2) — a retry
        // would just burn another network round-trip nobody is waiting on.
        // Fire-and-forget: resolve without a second attempt.
        if (signal?.aborted) return;
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
  async ingestTranscript(payload: TranscriptIngestPayload, signal?: AbortSignal): Promise<void> {
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
        signal,
      );
      await assertOk(res, 'ingest/transcript');
    };

    try {
      await attemptIngestTranscript();
    } catch (err: unknown) {
      if (err instanceof TransientError) {
        // Caller already gave up (issue #29 review finding #2) — skip the
        // retry rather than firing another network round-trip nobody is
        // waiting on. Fire-and-forget: resolve without a second attempt.
        if (signal?.aborted) return;
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

  async recall(req: RecallRequest, signal?: AbortSignal): Promise<RecallResponse> {
    const headers = await buildHeaders();
    // FEAT-423: the daemon's POST /recall reads scoping under a nested
    // `filters` object ({ repo, project, agent }) — NOT top-level. Sending
    // repo/project/agent flat (the prior shape) made every filter a silent
    // no-op (issue #56: "any --project value returns everything"). Shared
    // mapper (src/lib/wire-mapping.ts, #26) omits the key entirely when
    // empty so an unscoped recall stays byte-identical to before.
    const filters = mapRecallRequestToLocalFilters(req);
    const body = {
      query: req.query,
      k: req.k,
      ...(filters ? { filters } : {}),
    };
    const res = await fetchWithTimeout(
      `${this.baseUrl}/recall`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
      5000,
      signal,
    );
    await assertOk(res, 'recall');
    const json: unknown = await res.json();
    return RecallResponseSchema.parse(json);
  }

  async remember(req: IngestPayload, signal?: AbortSignal): Promise<void> {
    // U3c-plugin (#38/#44): the local daemon has no writer for the cloud-only
    // memory types (preference/task_result/summary). Reject them at the
    // boundary so they fail fast with a clear, non-retriable error instead of
    // 422/collapsing server-side.
    if (!LocalAtomTypeSchema.safeParse(req.type).success) {
      throw new DeterministicError(
        `local daemon has no writer for memory type '${req.type}' — local types: ${LOCAL_ATOM_TYPES.join(', ')}`,
        422,
      );
    }
    const headers = await buildHeaders();
    const res = await fetchWithTimeout(
      `${this.baseUrl}/remember`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
      },
      5000,
      signal,
    );
    await assertOk(res, 'remember');
  }

  async health(signal?: AbortSignal): Promise<HealthResponse> {
    const t0 = Date.now();
    const headers = await buildHeaders();
    const res = await fetchWithTimeout(
      `${this.baseUrl}/health`,
      { method: 'GET', headers },
      3000,
      signal,
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
