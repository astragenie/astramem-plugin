// Wire-level Zod schemas for the AstraMemory API.
// Shared between local and SaaS providers.
// Decisions 7-9 from memory-plugin#8: unified shape with required id/type/text/score;
// optional source/importance/confidence.
import { z } from 'zod';
import { CaptureEnvelopeV1Schema, type CaptureEnvelopeV1 } from '@astragenie/astramem-contracts/zod';

// ---------------------------------------------------------------------------
// Wire version — bump when the canonical envelope shape changes in a
// backwards-incompatible way.  Server rejects unknown versions starting v0.8.0.
// ---------------------------------------------------------------------------

export const WIRE_VERSION = 'v1.0' as const;

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export const IngestPayloadSchema = z.object({
  /** Unique identifier for the session or item being ingested. */
  id: z.string().min(1),
  /** Content type: 'transcript' | 'note' | 'fact' | 'decision' | etc. */
  type: z.string().min(1),
  /** The text content to ingest. */
  text: z.string().min(1),
  /** Optional: originating source identifier (e.g. repo name, file path). */
  source: z.string().optional(),
  /** Optional: importance score 0..1. */
  importance: z.number().min(0).max(1).optional(),
  /** Optional: provider confidence 0..1. */
  confidence: z.number().min(0).max(1).optional(),
  /** Optional: additional key/value metadata. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type IngestPayload = z.infer<typeof IngestPayloadSchema>;

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

export const RecallRequestSchema = z.object({
  /** Natural-language query string. */
  query: z.string().min(1),
  /** Maximum number of results to return (default: 5). */
  k: z.number().int().min(1).max(100).default(5),
  /** Optional: filter by repo name. */
  repo: z.string().optional(),
  /** Optional: filter by project/workspace. Single value or a list (OR).
   *  Local daemon exact-matches `provenance.project` (FEAT-423). */
  project: z.union([z.string(), z.array(z.string())]).optional(),
  /** Optional: filter by provenance agent/agent_type. Single value or a list
   *  (OR). Local daemon exact-matches `provenance.agent` (FEAT-423). */
  agent: z.union([z.string(), z.array(z.string())]).optional(),
});

export type RecallRequest = z.infer<typeof RecallRequestSchema>;

/** One memory hit in the recall response. */
export const RecallHitSchema = z.object({
  /** Unique ID of the memory item. */
  id: z.string(),
  /** Content type. */
  type: z.string(),
  /** The text of the memory. */
  text: z.string(),
  /** Relevance score 0..1 (higher = more relevant). */
  score: z.number().min(0).max(1),
  /** Optional originating source. */
  source: z.string().optional(),
  /** Optional importance weight. */
  importance: z.number().min(0).max(1).optional(),
  /** Optional provider confidence. */
  confidence: z.number().min(0).max(1).optional(),
});

export type RecallHit = z.infer<typeof RecallHitSchema>;

export const RecallResponseSchema = z.object({
  hits: z.array(RecallHitSchema),
  /** Total number of items searched. */
  total_searched: z.number().int().optional(),
  /** Provider that served the response. */
  provider: z.string().optional(),
});

export type RecallResponse = z.infer<typeof RecallResponseSchema>;

// ---------------------------------------------------------------------------
// Transcript ingest (ingest-transcript subcommand — FEAT 4a §4.1.1)
// ---------------------------------------------------------------------------
// Sourced from @astragenie/astramem-contracts — this endpoint IS the
// astramem-capture@1 envelope (ADR-008); the canonical schema's own field
// comment for wire_version literally says "Mirrors WIRE_VERSION_PATTERN in
// contracts/wire.ts", i.e. this file used to be the thing it now imports.
// Kept under the plugin's historical names (TranscriptIngestPayload*) so
// provider.ts / local.ts / saas.ts / cli/ingest-transcript.ts / lib/pending.ts
// don't need renaming.
//
// One deliberate divergence, NOT resolved by a straight re-export: canonical
// makes `turns` optional (to support the turns-less 'events' kind) and, when
// present, requires min 1 item — it has no representation for "an envelope
// with zero turns". The plugin needs exactly that (a session with no
// user/assistant lines still gets an envelope — see
// tests/cli/ingest-transcript.test.ts "omits turns key..."). The fix lives at
// the producer: cli/ingest-transcript.ts omits the `turns` key entirely
// instead of sending `turns: []`, which stays valid against the canonical
// schema. providers/local.ts and providers/saas.ts preserve that omission
// through their scrub-and-repost step. See tests/contracts/transcript-wire.test.ts
// for the corrected contract (turns omitted = valid, turns: [] = invalid).
export const TranscriptIngestPayloadSchema = CaptureEnvelopeV1Schema;
export type TranscriptIngestPayload = CaptureEnvelopeV1;

/** One transcript turn, projected out of the canonical envelope's `turns`
 * tuple so callers that assemble turns before building the envelope
 * (cli/ingest-transcript.ts) keep a standalone type. */
export type TranscriptTurn = NonNullable<CaptureEnvelopeV1['turns']>[number];

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  /** Provider version string. */
  version: z.string().optional(),
  /** The base URL that was probed. */
  url: z.string().optional(),
  /** Round-trip latency in milliseconds. */
  latencyMs: z.number().optional(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
