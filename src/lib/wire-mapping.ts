/**
 * Shared wire-mapping layer between the plugin's unified contracts
 * (contracts/wire.ts) and each backend's native REST wire shape.
 *
 * astramem-local speaks the unified shape directly (see providers/local.ts)
 * and only needs the FEAT-423 `filters` envelope built for recall(). The
 * SaaS REST API predates the unified contract (FEAT 4a §4.2.4) and uses its
 * own field names — top_k/project_id/content/rank_score/... — so this
 * module is the single mapping surface both providers import from. It
 * replaces the inline per-method adapter that used to live directly inside
 * src/providers/saas.ts (#26 — "delete U0 inline adapter; both providers
 * consume canonical types + one shared mapping layer").
 */
import { z } from 'zod';
import type { IngestPayload, MemoryType, RecallRequest, RecallResponse } from '../contracts/wire.ts';
import { RecallResponseSchema } from '../contracts/wire.ts';

// ---------------------------------------------------------------------------
// Local daemon — recall() filters envelope (FEAT-423)
// ---------------------------------------------------------------------------

/**
 * Build the local daemon's nested `filters` object from a unified
 * RecallRequest. The daemon's POST /recall reads repo/project/agent under
 * `filters`, not top-level (issue #56: "any --project value returns
 * everything") — returns undefined when no filter is set so an unscoped
 * recall body stays byte-identical to before.
 */
export function mapRecallRequestToLocalFilters(req: RecallRequest): Record<string, unknown> | undefined {
  const filters: Record<string, unknown> = {};
  if (req.repo !== undefined) filters['repo'] = req.repo;
  if (req.project !== undefined) filters['project'] = req.project;
  if (req.agent !== undefined) filters['agent'] = req.agent;
  return Object.keys(filters).length > 0 ? filters : undefined;
}

// ---------------------------------------------------------------------------
// SaaS REST wire shapes
// Mirrors C:\work\mega\memory\src\AstraMemory.Modules.Search\Application\SearchQuery.cs
// and Modules.Memories\Models\MemoryModels.cs (StoreMemoryRequest).
// ---------------------------------------------------------------------------

/** Result item subset we consume from SaaS POST /memories/search. Passthrough
 * of unknown fields is fine — .parse strips them (non-strict). `type` stays
 * a bare string here (raw wire decode); the canonical MemoryType boundary
 * check happens once, downstream, in mapSaasResponseToRecallResponse via
 * RecallResponseSchema.parse(). */
export const SaasSearchResultItemSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  type: z.string(),
  content: z.string(),
  importance: z.number().optional(),
  rank_score: z.number(),
  source: z.string().nullable().optional(),
  confidence_score: z.number().optional(),
});

export const SaasSearchResponseSchema = z.object({
  results: z.array(SaasSearchResultItemSchema),
  total: z.number().int(),
});

export type SaasSearchResponse = z.infer<typeof SaasSearchResponseSchema>;

/** Clamp to the RecallHit score domain [0,1] — rank_score is a weighted blend
 * that should already be in-domain, but the reranker path may perturb it. */
function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Derive the SaaS project_id for remember().
 * SaaS POST /memories rejects requests without project_id (400). Precedence:
 * metadata.project_id → metadata.project → cwdBasename — the same
 * default-workspace convention astramem-local uses (repo dir name). Callers
 * pass basename(process.cwd()) so this module stays free of node:path /
 * process coupling and is easy to unit test in isolation.
 */
export function resolveSaasProjectId(
  metadata: Record<string, unknown> | undefined,
  cwdBasename: string,
): string {
  const explicit = metadata?.['project_id'] ?? metadata?.['project'];
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return cwdBasename;
}

/**
 * Map a unified RecallRequest → SaaS SearchRequest body. top_k takes
 * precedence over limit server-side and is capped at 50 there; repo maps to
 * `source` (the SaaS field for originating repo/file) and project to
 * project_id. project/agent forward string|string[] verbatim (RecallRequest
 * allows both since v0.6.0) — the SaaS side is expected to accept the same
 * union. agent was previously dropped here (FEAT-424) — SaaS agent-filter
 * support is pending server-side (astragenie/memory); forwarded defensively
 * so the plugin is ready the moment the SaaS API accepts it.
 */
export function mapRecallRequestToSaas(req: RecallRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: req.query,
    top_k: req.k,
  };
  if (req.project !== undefined) body['project_id'] = req.project;
  if (req.repo !== undefined) body['source'] = req.repo;
  if (req.agent !== undefined) body['agent'] = req.agent;
  return body;
}

/**
 * Map a SaaS SearchResponse → unified RecallResponse. Validated against
 * RecallResponseSchema, which now enforces the canonical memory-type union
 * on every hit (#27) — a SaaS result carrying an unrecognised `type` fails
 * here with a clear ZodError rather than propagating an arbitrary string.
 */
export function mapSaasResponseToRecallResponse(saas: SaasSearchResponse): RecallResponse {
  const mapped: RecallResponse = {
    hits: saas.results.map((r) => ({
      id: r.id,
      // Cast is safe: RecallResponseSchema.parse() below is the actual
      // boundary enforcement — an unrecognised type throws there.
      type: r.type as MemoryType,
      text: r.content,
      score: clamp01(r.rank_score),
      ...(r.source != null ? { source: r.source } : {}),
      ...(r.importance !== undefined ? { importance: clamp01(r.importance) } : {}),
      ...(r.confidence_score !== undefined ? { confidence: clamp01(r.confidence_score) } : {}),
    })),
    total_searched: saas.total,
    provider: 'saas',
  };
  return RecallResponseSchema.parse(mapped);
}

/**
 * Map a unified IngestPayload → SaaS StoreMemoryRequest body. project_id is
 * required by the SaaS API; the plugin-side payload id is preserved as
 * metadata.client_id so round-trips stay traceable.
 */
export function mapIngestPayloadToSaasStore(
  req: IngestPayload,
  cwdBasename: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    content: req.text,
    type: req.type,
    project_id: resolveSaasProjectId(req.metadata, cwdBasename),
    metadata: { ...(req.metadata ?? {}), client_id: req.id },
  };
  if (req.importance !== undefined) body['importance'] = req.importance;
  if (req.confidence !== undefined) body['confidence'] = req.confidence;
  if (req.source !== undefined) body['source'] = req.source;
  return body;
}
