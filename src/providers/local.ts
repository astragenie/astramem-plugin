/**
 * Local AstraMemory provider.
 *
 * Implements MemoryProvider against the local daemon running at
 * http://127.0.0.1:7777 (or config.local.url / MEMORY_API_URL_LOCAL).
 *
 * recall/remember/health/ingestTranscript are implemented on top of
 * @astragenie/astramem-client's AstramemDaemonClient (the shared typed
 * daemon HTTP client — see that package's daemon-client.ts). ingest() stays
 * on hand-rolled fetch: its IngestPayload argument shape (id/type/text/...)
 * has no counterpart in the SDK's CanonicalIngestEnvelope-only
 * ingestTranscript() (no session_id/project_id/captured_at/wire_version),
 * and nothing in this codebase calls ingest() — it predates ingestTranscript
 * and is exercised only by tests exercising the MemoryProvider contract.
 *
 * Timeouts (unchanged from pre-SDK local.ts — enforced by constructing a
 * fresh AstramemDaemonClient per call with the method-specific timeoutMs,
 * since the SDK's timeoutMs is a single constructor-level value):
 *   ingest          — 2 s (fire-and-forget; retries 1x on 5xx / network error)
 *   ingestTranscript — 2 s (fire-and-forget; retries 1x via SDK's retryIngestOnTransient)
 *   recall          — 5 s
 *   remember        — 5 s
 *   health          — 3 s
 *
 * Error mapping:
 *   DaemonError{band:'deterministic'} -> DeterministicError (do not retry)
 *   DaemonError{band:'transient'}     -> TransientError (retry once for ingest; throw for recall/remember/health)
 *
 * Already-aborted signals: the SDK's internal fetch only *listens* for a
 * future 'abort' event on the caller-supplied signal — per the AbortSignal
 * spec, adding a listener to an already-aborted signal never fires it, so an
 * external signal that is aborted BEFORE the call would otherwise hang until
 * the internal timeout. assertNotAborted() below guards every SDK-routed
 * call so an already-given-up caller gets an immediate TransientError
 * instead of a wasted network attempt (a strict improvement — see the
 * ingestTranscript() pre-abort test note for the one observable behavior
 * change this causes).
 */

import type { MemoryProvider, ProviderCapabilities } from '../contracts/provider.ts';
import type {
  IngestPayload,
  RecallRequest,
  RecallResponse,
  HealthResponse,
  TranscriptIngestPayload,
} from '../contracts/wire.ts';
import { RecallResponseSchema, HealthResponseSchema } from '../contracts/wire.ts';
import { DeterministicError, TransientError } from '../lib/errors.ts';
import { readLocalBearer } from '../lib/secrets.ts';
import { resolveEnv } from '../lib/env.ts';
import { ENV } from '../lib/env-specs.ts';
import { scrubWithLabels } from '../lib/scrub.ts';
import { unrefTimer, linkSignals } from '../lib/abort.ts';
import { mapRecallRequestToLocalFilters } from '../lib/wire-mapping.ts';
import {
  AstramemDaemonClient,
  DaemonError,
  type DaemonRecallFilters,
  type DaemonRecallRequest,
  type DaemonRememberRequest,
} from '@astragenie/astramem-client';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const DEFAULT_LOCAL_URL = 'http://127.0.0.1:7777';

function resolveBaseUrl(): string {
  return resolveEnv(ENV.apiUrlLocal).value ?? DEFAULT_LOCAL_URL;
}

// ---------------------------------------------------------------------------
// SDK error mapping
// ---------------------------------------------------------------------------

/** Map a thrown DaemonError onto this plugin's DeterministicError/TransientError bands. Rethrows anything else unchanged. */
function rethrowAsProviderError(err: unknown): never {
  if (err instanceof DaemonError) {
    if (err.isDeterministic) throw new DeterministicError(err.message, err.status);
    throw new TransientError(err.message, err.status, err.cause);
  }
  throw err;
}

/**
 * Guard against an already-aborted external signal before handing off to the
 * SDK client (see module doc comment for why this is necessary).
 */
function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new TransientError('Request aborted by caller signal');
  }
}

// ---------------------------------------------------------------------------
// Fetch helpers — retained only for ingest() (see module doc comment).
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
   * Build a fresh AstramemDaemonClient for one call. Bearer is re-read every
   * time (readLocalBearer() supports token rotation without restart — same
   * as the pre-SDK buildHeaders()); timeoutMs is per-method since the SDK's
   * client only takes one constructor-level timeout.
   */
  private client(timeoutMs: number, opts: { retryIngestOnTransient?: boolean } = {}): AstramemDaemonClient {
    return new AstramemDaemonClient({
      baseUrl: this.baseUrl,
      bearer: readLocalBearer() ?? undefined,
      timeoutMs,
      retryIngestOnTransient: opts.retryIngestOnTransient ?? false,
    });
  }

  /**
   * Fire-and-forget ingest.  Retries once on TransientError within the 2s budget.
   * Never propagates errors — caller is insulated per the contract.
   *
   * Hand-rolled (not routed through AstramemDaemonClient) — see module doc
   * comment: IngestPayload has no CanonicalIngestEnvelope counterpart.
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
   * Posts a TranscriptIngestPayload to /ingest/transcript via
   * AstramemDaemonClient.ingestTranscript(), with the SDK's
   * retryIngestOnTransient handling the single retry-on-5xx/network-error.
   * Applies a scrub pass on turn text before POSTing (defense-in-depth: protects
   * programmatic callers that bypass the CLI scrub layer). If the payload already
   * carries client_scrub_applied=true, the scrub is still applied — scrubWithLabels
   * is idempotent (second pass on an already-redacted string is a no-op).
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

    try {
      // Already-aborted guard (see module doc comment). This means a caller
      // that hands in a pre-aborted signal now skips the network attempt
      // entirely rather than making one doomed request — an observable
      // change from the pre-SDK behavior, called out where it affects a test.
      assertNotAborted(signal);
      const client = this.client(2000, { retryIngestOnTransient: true });
      await client.ingestTranscript(scrubbedPayload, { signal });
    } catch {
      // Silently absorb — ingestTranscript is fire-and-forget (both the
      // deterministic and transient bands, and the pre-abort guard above).
    }
  }

  async recall(req: RecallRequest, signal?: AbortSignal): Promise<RecallResponse> {
    // FEAT-423: the daemon's POST /recall reads scoping under a nested
    // `filters` object ({ repo, project, agent }) — NOT top-level. Sending
    // repo/project/agent flat (the prior shape) made every filter a silent
    // no-op (issue #56: "any --project value returns everything"). Shared
    // mapper (src/lib/wire-mapping.ts, #26) omits the key entirely when
    // empty so an unscoped recall stays byte-identical to before. The SDK's
    // AstramemDaemonClient.recall() body shape matches this exactly (see
    // daemon-client.ts — it forwards `filters` verbatim), so no additional
    // call-site divergence-mapping is needed here.
    const filters = mapRecallRequestToLocalFilters(req);
    const daemonReq: DaemonRecallRequest = {
      query: req.query,
      k: req.k,
      ...(filters ? { filters: filters as DaemonRecallFilters } : {}),
    };
    try {
      assertNotAborted(signal);
      const client = this.client(5000);
      const raw = await client.recall(daemonReq, { signal });
      // raw is the full daemon JSON body (the SDK's DaemonRecallResponse type
      // is a minimal mirror) — re-validate with this plugin's own schema, same
      // as the pre-SDK implementation did directly off the parsed response.
      return RecallResponseSchema.parse(raw);
    } catch (err) {
      rethrowAsProviderError(err);
    }
  }

  async remember(req: IngestPayload, signal?: AbortSignal): Promise<void> {
    // The daemon's POST /remember (astramemory-local src/server/routes/search.ts
    // RememberBodySchema) expects {text, type, metadata:{repo,project,branch,
    // agent,importance,confidence}} — exactly the shape AstramemDaemonClient.
    // remember() builds. IngestPayload keeps importance/confidence top-level
    // and metadata as a free-form record, so map explicitly here.
    const metadata = req.metadata ?? {};
    const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const daemonReq: DaemonRememberRequest = {
      text: req.text,
      type: req.type,
      repo: asString(metadata['repo']),
      project: asString(metadata['project']),
      branch: asString(metadata['branch']),
      agent: asString(metadata['agent']),
      importance: req.importance,
      confidence: req.confidence,
    };
    try {
      assertNotAborted(signal);
      const client = this.client(5000);
      await client.remember(daemonReq, { signal });
    } catch (err) {
      rethrowAsProviderError(err);
    }
  }

  async health(signal?: AbortSignal): Promise<HealthResponse> {
    const t0 = Date.now();
    try {
      assertNotAborted(signal);
      const client = this.client(3000);
      const raw = await client.health({ signal });
      const latencyMs = Date.now() - t0;
      const parsed = HealthResponseSchema.parse(raw);
      return { ...parsed, url: this.baseUrl, latencyMs };
    } catch (err) {
      rethrowAsProviderError(err);
    }
  }
}

/** Factory — creates a LocalProvider with optional URL override from config. */
export function createLocalProvider(opts?: { url?: string }): LocalProvider {
  return new LocalProvider(opts?.url);
}
