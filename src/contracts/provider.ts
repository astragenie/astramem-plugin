// MemoryProvider interface — every provider (local, saas) must implement this.
// Input/output types are Zod-inferred from wire.ts.
import type { IngestPayload, RecallRequest, RecallResponse, HealthResponse, TranscriptIngestPayload } from './wire.ts';

/**
 * Backend capability flags (#26 — discriminated-union + capabilities).
 *
 * Cloud-only or backend-varying behavior must be exposed here so callers
 * branch explicitly on a capability flag (`if (provider.capabilities.asOf)`)
 * instead of probing a field that one backend silently never populates
 * (the `?? undefined` anti-pattern this replaces).
 *
 * Kept intentionally small and descriptive of what's ACTUALLY wired through
 * RecallRequestSchema/RecallHitSchema today — not aspirational. Grow this
 * object as those schemas gain the corresponding fields (as_of, per-signal
 * score explanation, etc.) rather than guessing ahead of the wire contract.
 *
 * Per-backend atom variants (AtomV1Local / AtomV1Cloud over a shared
 * AtomV1Base, as sketched by the architect) are NOT modeled yet:
 * @astragenie/astramem-contracts currently publishes one unified AtomV1
 * schema with no backend-specific split — adopting a discriminated atom
 * union is blocked on that upstream package support.
 */
export interface ProviderCapabilities {
  /** 'single' — one implicit tenant (local daemon on this machine).
   *  'multi' — backend scopes memories by workspace/org (SaaS). */
  tenancy: 'single' | 'multi';
  /** Whether recall() currently accepts a bitemporal as_of query
   *  (ADR-005 RetrievalQueryV1.filters.as_of). Neither provider wires this
   *  through RecallRequestSchema yet — false for both until that lands. */
  asOf: boolean;
  /** Score-explanation signal names this backend's recall results carry.
   *  Empty for both providers today — RecallHitSchema has no `explanation`
   *  field yet (ADR-005 ScoreExplanation is defined package-side but not
   *  wired through this plugin's wire contract). */
  explainSignals: string[];
}

export interface MemoryProvider {
  /** Static capability description for this backend — see ProviderCapabilities. */
  readonly capabilities: ProviderCapabilities;

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
