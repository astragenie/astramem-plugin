/**
 * Contract tests for TranscriptIngestPayloadSchema.
 * FEAT 4a §5.1 — transcript wire contract round-trip + reject malformed.
 *
 * TranscriptIngestPayloadSchema is sourced from @astragenie/astramem-contracts
 * (CaptureEnvelopeV1Schema) as of the contracts-import wave — see
 * src/contracts/wire.ts for the full rationale. Two assertions below
 * (turns required / empty turns allowed) were updated to match the canonical
 * contract: turns is now optional, and when present requires >=1 item.
 */
import { describe, it, expect } from 'vitest';
import {
  TranscriptIngestPayloadSchema,
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

// Turn-shape coverage (missing role/text, bad role enum, optional ts) lives in
// the "malformed turn" cases below, exercised at the envelope level — there is
// no standalone turn schema to test in isolation now that TranscriptTurn is a
// type projection off the canonical envelope, not its own zod schema.

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

  // turns is OPTIONAL on the canonical envelope (supports the turns-less
  // 'events' kind) — omitting the key is how a turns-less transcript session
  // is represented (see cli/ingest-transcript.ts). Was required pre-#53.
  it('allows missing turns', () => {
    const { turns: _t, ...rest } = VALID_ENVELOPE;
    const r = TranscriptIngestPayloadSchema.safeParse(rest);
    expect(r.success).toBe(true);
  });

  // Canonical requires >=1 item when turns IS present — [] is not a valid
  // way to say "no turns" (that's what omitting the key is for). Was
  // explicitly allowed pre-#53; reversed here to match the shared contract.
  it('rejects empty turns array', () => {
    const r = TranscriptIngestPayloadSchema.safeParse({ ...VALID_ENVELOPE, turns: [] });
    expect(r.success).toBe(false);
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
});
