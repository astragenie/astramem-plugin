// MemoryProvider interface — every provider (local, saas) must implement this.
// Input/output types are Zod-inferred from wire.ts.
import type { IngestPayload, RecallRequest, RecallResponse, HealthResponse, TranscriptIngestPayload } from './wire.ts';

export interface MemoryProvider {
  /**
   * Fire-and-forget ingest. Errors are logged but do not propagate to the caller.
   * Must complete or time out within 2 seconds.
   *
   * @param signal Optional caller-supplied AbortSignal. Combined with the
   *   provider's own internal deadline timer (issue #29) — whichever fires
   *   first aborts the in-flight request. Optional and backward-compatible;
   *   existing callers that omit it are unaffected.
   */
  ingest(payload: IngestPayload, signal?: AbortSignal): Promise<void>;

  /**
   * Fire-and-forget transcript ingest (FEAT 4a Phase 3).
   * Posts a full TranscriptIngestPayload envelope to /ingest/transcript.
   * Applies a defense-in-depth scrub on turn text before posting.
   * Errors never propagate — caller is insulated per fire-and-forget contract.
   *
   * @param signal Optional caller-supplied AbortSignal (see ingest() above).
   */
  ingestTranscript(payload: TranscriptIngestPayload, signal?: AbortSignal): Promise<void>;

  /**
   * Synchronous recall. Returns matched hits in unified RecallResponse shape.
   * Must complete within 5 seconds.
   *
   * @param signal Optional caller-supplied AbortSignal (see ingest() above).
   */
  recall(req: RecallRequest, signal?: AbortSignal): Promise<RecallResponse>;

  /**
   * Remember a new memory item. Similar to ingest but may return confirmation.
   *
   * @param signal Optional caller-supplied AbortSignal (see ingest() above).
   */
  remember(req: IngestPayload, signal?: AbortSignal): Promise<void>;

  /**
   * Health probe. Returns HealthResponse with ok=true if the provider is reachable.
   *
   * @param signal Optional caller-supplied AbortSignal (see ingest() above).
   */
  health(signal?: AbortSignal): Promise<HealthResponse>;
}
