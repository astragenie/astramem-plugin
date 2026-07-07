// Wire-level Zod schemas for the AstraMemory API.
// Shared between local and SaaS providers.
// Decisions 7-9 from memory-plugin#8: unified shape with required id/type/text/score;
// optional source/importance/confidence.
import { z } from 'zod';
import {
  AtomV1Schema,
  CaptureEnvelopeV1Schema as CanonicalCaptureEnvelopeV1Schema,
} from '@astragenie/astramem-contracts/zod';

// ---------------------------------------------------------------------------
// Wire version — bump when the canonical envelope shape changes in a
// backwards-incompatible way.  Server rejects unknown versions starting v0.8.0.
// ---------------------------------------------------------------------------

export const WIRE_VERSION = 'v1.0' as const;

// ---------------------------------------------------------------------------
// Canonical memory-type union (#27 — ADR-005 / U4 contract-unification)
// ---------------------------------------------------------------------------

/**
 * The memory-type registry, sourced directly from
 * `@astragenie/astramem-contracts`'s `AtomV1Schema` — the published
 * cross-repo source of truth (v1 registry: decision, fact, lesson, command,
 * todo, note, event, preference, task_result, summary — ADR D4). Reusing the
 * package's own ZodEnum instance (rather than re-declaring the literal list
 * here) keeps this union byte-identical to the published contract and picks
 * up additive registry growth the next time the package is bumped, instead
 * of drifting out of sync with a hand-copied list.
 *
 * Any bare-string memory-type field in this plugin's wire contracts should
 * use this schema so unknown types are rejected at the boundary with a
 * clear Zod error, rather than silently accepted as arbitrary strings.
 */
export const MemoryTypeSchema = AtomV1Schema.shape.type;
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

/**
 * Re-exported canonical capture envelope (ADR-008 astramem-capture@1),
 * unaltered. Used for cross-validation in
 * tests/contracts/transcript-wire.test.ts to prove every payload accepted by
 * this plugin's stricter TranscriptIngestPayloadSchema also validates
 * against the package's canonical envelope — see that schema's doc comment
 * for why the plugin keeps a local, stricter copy instead of importing this
 * one directly.
 */
export { CanonicalCaptureEnvelopeV1Schema };

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export const IngestPayloadSchema = z.object({
  /** Unique identifier for the session or item being ingested. */
  id: z.string().min(1),
  /** Canonical memory type (#27) — see MemoryTypeSchema. Unknown values are
   *  rejected here with a clear Zod error (e.g. src/cli/remember.ts's
   *  IngestPayloadSchema.safeParse() boundary check). */
  type: MemoryTypeSchema,
  /** The text content to ingest. */
  text: z.string().min(1),
  /** Optional: originating source identifier (e.g. repo name, file path). */
  source: z.string().optional(),
  /** Optional: importance score 0..1. */
  importance: z.number().min(0).max(1).optional(),
  /** Optional: provider confidence 0..1. */
  confidence: z.number().min(0).max(1).optional(),
  /** Optional: additional key/value metadata. */
  metadata: z.record(z.unknown()).optional(),
});

export type IngestPayload = z.infer<typeof IngestPayloadSchema>;

// ---------------------------------------------------------------------------
// Recall
//
// NOTE (#26): the package's RetrievalQueryV1Schema (ADR-005 cross-repo
// retrieval envelope) is NOT swapped in here. Its shape is a genuine
// divergence, not accidental duplication: RetrievalQueryV1 nests
// repo/project/agent/type under a `filters` object, calls the query string
// `text` and the page size `limit`, and requires a `mode`. This plugin's
// RecallRequestSchema is the flat, CLI/provider-ergonomic shape every
// current caller (src/cli/recall.ts, LocalProvider, SaasProvider, the
// shared provider contract tests) already depends on — reshaping it would
// break that backward-compatible surface for no behavioral gain, since
// providers already do their own backend-specific mapping (see
// src/lib/wire-mapping.ts). Revisit if/when a caller needs `mode`, `as_of`,
// or `entity` filtering — at that point extend this schema additively
// rather than replacing it wholesale.
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
  /** Canonical memory type (#27) — see MemoryTypeSchema. A provider response
   *  with an unrecognised type fails RecallResponseSchema.parse() with a
   *  clear ZodError instead of silently passing an arbitrary string
   *  through to callers. */
  type: MemoryTypeSchema,
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

export const TranscriptTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  ts: z.string().optional(), // ISO-8601 if present
});

export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;

// Aligned with SaaS canonical IngestTranscriptRequest at:
//   C:\work\mega\memory\src\AstraMemory.Api\Models\IngestTranscriptRequest.cs
// Plus Slice 3.5 additions (client_scrub_version, client_scrub_hits_by_label, wire_version).
// wire_version is REQUIRED (Phase 3 Stage 1 — FEAT 4a) — server uses it for
// daemon-divergence detection; nullable would defeat that purpose.
// .strict() rejects unknown fields — callers must map explicitly; prevents
// accidental PII leakage through unrecognised keys, and forces consumers to
// add new optional fields rather than forwarding arbitrary objects.
//
// NOTE (#26): the package's CaptureEnvelopeV1Schema (ADR-008
// astramem-capture@1) is this schema's canonical upstream counterpart and
// is intentionally NOT swapped in directly. It is a superset that also
// covers the 'events' capture kind (pre-typed atom candidates that skip
// pipeline stages 1-5) — under that kind `turns` is absent and `events` is
// populated instead. This plugin only ever emits `kind: 'transcript'` today
// (src/cli/ingest-transcript.ts), so TranscriptIngestPayloadSchema keeps
// `turns` REQUIRED (see "rejects missing turns" in
// tests/contracts/transcript-wire.test.ts) — a genuine, documented
// divergence, not duplicated maintenance: the canonical schema's own
// `turns` is optional precisely because the envelope aims to be valid
// without it, which is not a state this plugin's writer path ever produces.
// A cross-validation test below asserts every envelope this plugin emits
// also parses against CanonicalCaptureEnvelopeV1Schema, so the two shapes
// can't silently drift apart.
export const TranscriptIngestPayloadSchema = z.object({
  /** Wire format version — must equal WIRE_VERSION. Pattern: ASCII digits only, no
   * leading zeros. Matches SaaS .NET DTO regex authoritatively (see memory
   * IngestTranscriptRequest.cs M-R7). \d would match Unicode-category-Decimal
   * (e.g. Arabic-Indic ١) — undesirable for a wire dispatch field. */
  wire_version: z.string().regex(/^v(?:0|[1-9][0-9]*)\.[0-9]+$/),
  event: z.enum(['pre_compact', 'session_end', 'subagent_stop']),
  session_id: z.string(),
  project_id: z.string(),
  agent_type: z.string().optional(),
  cwd: z.string().optional(),
  captured_at: z.string(), // ISO-8601
  turns: z.array(TranscriptTurnSchema),
  /** @deprecated use client_scrub_version + client_scrub_hits_by_label (v0.7.0 removal) */
  client_scrub_applied: z.boolean(),
  /** @deprecated use client_scrub_hits_by_label sum (v0.7.0 removal) */
  client_scrub_hits: z.number().int().nonnegative(),
  client_version: z.string(),
  /** Scrubber version constant — consumers can assert minimum version. */
  client_scrub_version: z.string(),
  /** Per-label hit counts from scrubWithLabels() across all turns. */
  client_scrub_hits_by_label: z.record(z.string(), z.number().int().nonnegative()).optional(),
}).strict();

export type TranscriptIngestPayload = z.infer<typeof TranscriptIngestPayloadSchema>;

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
