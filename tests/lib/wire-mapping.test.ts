/**
 * Unit tests for src/lib/wire-mapping.ts — the shared SaaS/local wire
 * mapping layer extracted from the former inline U0 adapter in
 * src/providers/saas.ts (#26).
 */
import { describe, it, expect } from 'vitest';
import {
  mapRecallRequestToLocalFilters,
  mapRecallRequestToSaas,
  mapSaasResponseToRecallResponse,
  mapIngestPayloadToSaasStore,
  resolveSaasProjectId,
  SaasSearchResponseSchema,
} from '../../src/lib/wire-mapping.ts';
import type { IngestPayload, RecallRequest } from '../../src/contracts/wire.ts';

describe('mapRecallRequestToLocalFilters', () => {
  it('returns undefined when no filter fields are set', () => {
    const req: RecallRequest = { query: 'q', k: 5 };
    expect(mapRecallRequestToLocalFilters(req)).toBeUndefined();
  });

  it('builds a filters object with only the fields present', () => {
    const req: RecallRequest = { query: 'q', k: 5, repo: 'r1', project: 'p1' };
    expect(mapRecallRequestToLocalFilters(req)).toEqual({ repo: 'r1', project: 'p1' });
  });

  it('forwards array-valued project/agent verbatim', () => {
    const req: RecallRequest = { query: 'q', k: 5, project: ['a', 'b'], agent: ['x'] };
    expect(mapRecallRequestToLocalFilters(req)).toEqual({ project: ['a', 'b'], agent: ['x'] });
  });
});

describe('mapRecallRequestToSaas', () => {
  it('maps k -> top_k and passes query through', () => {
    const req: RecallRequest = { query: 'q', k: 7 };
    expect(mapRecallRequestToSaas(req)).toEqual({ query: 'q', top_k: 7 });
  });

  it('maps repo -> source and project -> project_id', () => {
    const req: RecallRequest = { query: 'q', k: 7, repo: 'repo-b', project: 'proj-a' };
    expect(mapRecallRequestToSaas(req)).toMatchObject({ source: 'repo-b', project_id: 'proj-a' });
  });

  it('omits agent when undefined, forwards when present', () => {
    const req: RecallRequest = { query: 'q', k: 7 };
    expect(mapRecallRequestToSaas(req)).not.toHaveProperty('agent');
    expect(mapRecallRequestToSaas({ ...req, agent: 'claude-code' })).toMatchObject({ agent: 'claude-code' });
  });
});

describe('mapSaasResponseToRecallResponse', () => {
  it('maps content->text, rank_score->score (clamped), and validates the canonical type', () => {
    const saas = SaasSearchResponseSchema.parse({
      results: [
        { id: 'a1', type: 'note', content: 'hello', rank_score: 0.5 },
      ],
      total: 1,
    });
    const mapped = mapSaasResponseToRecallResponse(saas);
    expect(mapped.provider).toBe('saas');
    expect(mapped.total_searched).toBe(1);
    expect(mapped.hits[0]).toMatchObject({ id: 'a1', type: 'note', text: 'hello', score: 0.5 });
  });

  it('clamps out-of-range rank_score into [0,1]', () => {
    const saas = SaasSearchResponseSchema.parse({
      results: [{ id: 'a1', type: 'fact', content: 'x', rank_score: 1.5 }],
      total: 1,
    });
    const mapped = mapSaasResponseToRecallResponse(saas);
    expect(mapped.hits[0]?.score).toBe(1);
  });

  it('throws (clear ZodError) when a hit carries a non-canonical type (#27)', () => {
    const saas = SaasSearchResponseSchema.parse({
      results: [{ id: 'a1', type: 'not-a-real-type', content: 'x', rank_score: 0.5 }],
      total: 1,
    });
    expect(() => mapSaasResponseToRecallResponse(saas)).toThrow();
  });
});

describe('resolveSaasProjectId', () => {
  it('prefers metadata.project_id', () => {
    expect(resolveSaasProjectId({ project_id: 'explicit', project: 'other' }, 'cwd-base')).toBe('explicit');
  });

  it('falls back to metadata.project', () => {
    expect(resolveSaasProjectId({ project: 'proj-x' }, 'cwd-base')).toBe('proj-x');
  });

  it('falls back to cwdBasename when metadata has neither', () => {
    expect(resolveSaasProjectId(undefined, 'cwd-base')).toBe('cwd-base');
  });
});

describe('mapIngestPayloadToSaasStore', () => {
  it('maps text -> content, preserves type, derives project_id, stashes client_id', () => {
    const req: IngestPayload = { id: 'req-1', type: 'decision', text: 'hello' };
    const body = mapIngestPayloadToSaasStore(req, 'cwd-base');
    expect(body).toMatchObject({
      content: 'hello',
      type: 'decision',
      project_id: 'cwd-base',
    });
    expect((body['metadata'] as Record<string, unknown>)['client_id']).toBe('req-1');
    expect(body).not.toHaveProperty('text');
  });

  it('forwards optional importance/confidence/source when present', () => {
    const req: IngestPayload = {
      id: 'req-2', type: 'fact', text: 'hi',
      importance: 0.5, confidence: 0.8, source: 'repo-x',
    };
    const body = mapIngestPayloadToSaasStore(req, 'cwd-base');
    expect(body).toMatchObject({ importance: 0.5, confidence: 0.8, source: 'repo-x' });
  });
});
