/**
 * Contract tests for TranscriptTurnSchema + TranscriptIngestPayloadSchema.
 * FEAT 4a §5.1 — transcript wire contract round-trip + reject malformed.
 */
import { describe, it, expect } from 'vitest';
import {
  TranscriptTurnSchema,
  TranscriptIngestPayloadSchema,
  CanonicalCaptureEnvelopeV1Schema,
  MemoryTypeSchema,
  IngestPayloadSchema,
  RecallHitSchema,
  WIRE_VERSION,
} from '../../src/contracts/wire.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_TURN_USER = { role: 'user', text: 'Hello from user' };
const VALID_TURN_ASSISTANT = { role: 'assistant', text: 'Hello from assistant', ts: '2026-01-01T00:00:00Z' };

const VALID_ENVELOPE = {
  wire_version: WIRE_VERSION,
  event: 'pre_compact',
  session_id: 'sess-abc',
  project_id: 'proj-xyz',
  captured_at: '2026-06-29T12:00:00Z',
  turns: [VALID_TURN_USER, VALID_TURN_ASSISTANT],
  client_scrub_applied: true,
  client_scrub_hits: 0,
  client_version: '0.5.0',
  client_scrub_version: '2',
};

// ---------------------------------------------------------------------------
// TranscriptTurnSchema
// ---------------------------------------------------------------------------

describe('TranscriptTurnSchema', () => {
  it('parses a valid user turn without ts', () => {
    const r = TranscriptTurnSchema.safeParse({ role: 'user', text: 'hello' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.role).toBe('user');
      expect(r.data.ts).toBeUndefined();
    }
  });

  it('parses a valid assistant turn with ts', () => {
    const r = TranscriptTurnSchema.safeParse({ role: 'assistant', text: 'reply', ts: '2026-01-01T00:00:00Z' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.role).toBe('assistant');
      expect(r.data.ts).toBe('2026-01-01T00:00:00Z');
    }
  });

  it('rejects missing role', () => {
    const r = TranscriptTurnSchema.safeParse({ text: 'no role' });
    expect(r.success).toBe(false);
  });

  it('rejects missing text', () => {
    const r = TranscriptTurnSchema.safeParse({ role: 'user' });
    expect(r.success).toBe(false);
  });

  it('rejects invalid role enum (system)', () => {
    const r = TranscriptTurnSchema.safeParse({ role: 'system', text: 'system message' });
    expect(r.success).toBe(false);
  });

  it('rejects invalid role enum (tool)', () => {
    const r = TranscriptTurnSchema.safeParse({ role: 'tool', text: 'tool message' });
    expect(r.success).toBe(false);
  });

  it('ts field is optional — absent is OK', () => {
    const r = TranscriptTurnSchema.safeParse({ role: 'assistant', text: 'no ts' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TranscriptIngestPayloadSchema
// ---------------------------------------------------------------------------

describe('TranscriptIngestPayloadSchema', () => {
  it('parses a fully valid envelope', () => {
    const r = TranscriptIngestPayloadSchema.safeParse(VALID_ENVELOPE);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.event).toBe('pre_compact');
      expect(r.data.session_id).toBe('sess-abc');
      expect(r.data.turns).toHaveLength(2);
      expect(r.data.client_scrub_applied).toBe(true);
      expect(r.data.client_scrub_hits).toBe(0);
    }
  });

  it('parses all three valid event values', () => {
    for (const event of ['pre_compact', 'session_end', 'subagent_stop'] as const) {
      const r = TranscriptIngestPayloadSchema.safeParse({ ...VALID_ENVELOPE, event });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.event).toBe(event);
    }
  });

  it('rejects invalid event value', () => {
    const r = TranscriptIngestPayloadSchema.safeParse({ ...VALID_ENVELOPE, event: 'post_compact' });
    expect(r.success).toBe(false);
  });

  it('rejects missing event', () => {
    const { event: _e, ...rest } = VALID_ENVELOPE;
    const r = TranscriptIngestPayloadSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it('rejects missing session_id', () => {
    const { session_id: _s, ...rest } = VALID_ENVELOPE;
    const r = TranscriptIngestPayloadSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it('rejects missing project_id', () => {
    const { project_id: _p, ...rest } = VALID_ENVELOPE;
    const r = TranscriptIngestPayloadSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it('rejects missing captured_at', () => {
    const { captured_at: _c, ...rest } = VALID_ENVELOPE;
    const r = TranscriptIngestPayloadSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it('rejects missing turns', () => {
    const { turns: _t, ...rest } = VALID_ENVELOPE;
    const r = TranscriptIngestPayloadSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it('allows empty turns array', () => {
    const r = TranscriptIngestPayloadSchema.safeParse({ ...VALID_ENVELOPE, turns: [] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.turns).toHaveLength(0);
  });

  it('rejects malformed turn (missing role)', () => {
    const r = TranscriptIngestPayloadSchema.safeParse({
      ...VALID_ENVELOPE,
      turns: [{ text: 'no role here' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects malformed turn (missing text)', () => {
    const r = TranscriptIngestPayloadSchema.safeParse({
      ...VALID_ENVELOPE,
      turns: [{ role: 'user' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects malformed turn (wrong role enum)', () => {
    const r = TranscriptIngestPayloadSchema.safeParse({
      ...VALID_ENVELOPE,
      turns: [{ role: 'system', text: 'bad role' }],
    });
    expect(r.success).toBe(false);
  });

  it('optional fields agent_type + cwd absent by default', () => {
    const r = TranscriptIngestPayloadSchema.safeParse(VALID_ENVELOPE);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.agent_type).toBeUndefined();
      expect(r.data.cwd).toBeUndefined();
    }
  });

  it('optional fields agent_type + cwd accepted when present', () => {
    const r = TranscriptIngestPayloadSchema.safeParse({
      ...VALID_ENVELOPE,
      agent_type: 'aiplugin-dev',
      cwd: '/home/user/project',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.agent_type).toBe('aiplugin-dev');
      expect(r.data.cwd).toBe('/home/user/project');
    }
  });

  it('rejects negative client_scrub_hits', () => {
    const r = TranscriptIngestPayloadSchema.safeParse({ ...VALID_ENVELOPE, client_scrub_hits: -1 });
    expect(r.success).toBe(false);
  });

  it('client_scrub_hits = 0 is valid', () => {
    const r = TranscriptIngestPayloadSchema.safeParse({ ...VALID_ENVELOPE, client_scrub_hits: 0 });
    expect(r.success).toBe(true);
  });

  it('client_scrub_hits = 5 is valid', () => {
    const r = TranscriptIngestPayloadSchema.safeParse({ ...VALID_ENVELOPE, client_scrub_hits: 5 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.client_scrub_hits).toBe(5);
  });

  it('turn ts optional — present and absent both work', () => {
    const withTs = { ...VALID_ENVELOPE, turns: [{ role: 'user', text: 'hi', ts: '2026-01-01T00:00:00Z' }] };
    const withoutTs = { ...VALID_ENVELOPE, turns: [{ role: 'user', text: 'hi' }] };
    expect(TranscriptIngestPayloadSchema.safeParse(withTs).success).toBe(true);
    expect(TranscriptIngestPayloadSchema.safeParse(withoutTs).success).toBe(true);
  });

  // ------------------------------------------------------------------
  // wire_version — required, pattern ^v\d+\.\d+$
  // ------------------------------------------------------------------

  it('wire_version is present and equals WIRE_VERSION in VALID_ENVELOPE', () => {
    const r = TranscriptIngestPayloadSchema.safeParse(VALID_ENVELOPE);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.wire_version).toBe(WIRE_VERSION);
  });

  it('rejects missing wire_version', () => {
    const { wire_version: _w, ...rest } = VALID_ENVELOPE;
    const r = TranscriptIngestPayloadSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it('rejects wire_version with wrong pattern (no v prefix)', () => {
    const r = TranscriptIngestPayloadSchema.safeParse({ ...VALID_ENVELOPE, wire_version: '1.0' });
    expect(r.success).toBe(false);
  });

  it('rejects wire_version with wrong pattern (free text)', () => {
    const r = TranscriptIngestPayloadSchema.safeParse({ ...VALID_ENVELOPE, wire_version: 'latest' });
    expect(r.success).toBe(false);
  });

  it('accepts any valid semver-style wire_version (future version)', () => {
    const r = TranscriptIngestPayloadSchema.safeParse({ ...VALID_ENVELOPE, wire_version: 'v2.0' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.wire_version).toBe('v2.0');
  });

  // ------------------------------------------------------------------
  // #26 — cross-validation against the canonical
  // @astragenie/astramem-contracts CaptureEnvelopeV1Schema (astramem-capture@1).
  // Proves the plugin's stricter local schema stays a valid subset of the
  // published cross-repo envelope instead of silently drifting from it.
  // ------------------------------------------------------------------

  it('every envelope accepted locally also validates against the canonical CaptureEnvelopeV1Schema', () => {
    const local = TranscriptIngestPayloadSchema.parse(VALID_ENVELOPE);
    const canonical = CanonicalCaptureEnvelopeV1Schema.safeParse(local);
    expect(canonical.success).toBe(true);
  });

  it('the canonical schema still accepts a kind:"transcript" envelope with an unrecognised extra field', () => {
    // Canonical envelope covers both 'transcript' and 'events' kinds; the
    // plugin only ever emits 'transcript'. This asserts the canonical
    // schema's `kind` defaulting doesn't reject our shape when explicit.
    const r = CanonicalCaptureEnvelopeV1Schema.safeParse({ ...VALID_ENVELOPE, kind: 'transcript' });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MemoryTypeSchema (#27) — canonical memory-type union sourced from
// @astragenie/astramem-contracts's AtomV1Schema.
// ---------------------------------------------------------------------------

describe('MemoryTypeSchema', () => {
  const CANONICAL_TYPES = [
    'decision', 'fact', 'lesson', 'command', 'todo',
    'note', 'event', 'preference', 'task_result', 'summary',
  ];

  it('accepts all 10 ADR-005 canonical values', () => {
    for (const t of CANONICAL_TYPES) {
      expect(MemoryTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it('rejects a non-canonical free-form string', () => {
    expect(MemoryTypeSchema.safeParse('transcript').success).toBe(false);
    expect(MemoryTypeSchema.safeParse('whatever').success).toBe(false);
  });

  it('IngestPayloadSchema rejects an unknown type with a clear error', () => {
    const r = IngestPayloadSchema.safeParse({ id: 'x', type: 'bogus-type', text: 'hi' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('type'))).toBe(true);
    }
  });

  it('IngestPayloadSchema accepts a canonical type', () => {
    const r = IngestPayloadSchema.safeParse({ id: 'x', type: 'decision', text: 'hi' });
    expect(r.success).toBe(true);
  });

  it('RecallHitSchema rejects an unknown type', () => {
    const r = RecallHitSchema.safeParse({ id: 'h1', type: 'transcript', text: 'hi', score: 0.5 });
    expect(r.success).toBe(false);
  });

  it('RecallHitSchema accepts a canonical type', () => {
    const r = RecallHitSchema.safeParse({ id: 'h1', type: 'fact', text: 'hi', score: 0.5 });
    expect(r.success).toBe(true);
  });
});
