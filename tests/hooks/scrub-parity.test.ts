/**
 * Scrub parity test — §5.3 BLOCKING merge gate (FEAT 4a).
 *
 * Feeds each fixture entry from tests/hooks/fixtures/scrub/inputs.jsonl through
 * both scrub paths and asserts identical output:
 *
 *   Bash:  hooks/scripts/_ingest-transcript.sh --scrub-only <file>
 *          → JSON { text: string; hits: number }
 *
 *   JS:    src/lib/scrub.ts scrub() → string
 *
 * When outputs diverge, the test is pinned as it.todo() with a documented reason.
 * See tests/hooks/fixtures/scrub/PARITY_DIVERGENCE.md for the full divergence report.
 *
 * KNOWN DIVERGENCES (as of FEAT 4a Slice 3):
 *   - jwt, aws-key, aws-secret, anthropic-key, generic-secret:
 *     bash scrubs them; JS does NOT. Bash is safer.
 *   - bearer-hex:
 *     JS scrubs them; bash does NOT. JS is safer.
 *   - See PARITY_DIVERGENCE.md for per-entry detail.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrub } from '../../src/lib/scrub.ts';

// ---------------------------------------------------------------------------
// Platform skip — bash required for the bash side of the parity check.
// On Windows without Git Bash / Cygwin the test file is still collected but
// the entire suite is skipped rather than erroring.
// ---------------------------------------------------------------------------

function hasBash(): boolean {
  try {
    const r = spawnSync('bash', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

const bashAvailable = hasBash();
const HELPER = join(process.cwd(), 'hooks', 'scripts', '_ingest-transcript.sh');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FixtureEntry {
  id: string;
  category: string;
  input: string;
  expect_scrubbed: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load all entries from inputs.jsonl */
function loadFixtures(): FixtureEntry[] {
  const fixturePath = join(process.cwd(), 'tests', 'hooks', 'fixtures', 'scrub', 'inputs.jsonl');
  const lines = readFileSync(fixturePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as FixtureEntry);
}

/** Run the bash --scrub-only path and return the scrubbed text. */
function runBashScrub(input: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'scrub-parity-'));
  try {
    const inputFile = join(dir, 'in.txt');
    writeFileSync(inputFile, input, 'utf-8');
    const r = spawnSync('bash', [HELPER, '--scrub-only', inputFile], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    if (r.status !== 0) {
      throw new Error(`bash scrub exited ${String(r.status)}: ${r.stderr}`);
    }
    const parsed = JSON.parse(r.stdout) as { text: string; hits: number };
    return parsed.text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run JS scrub on a plain string input. */
function runJsScrub(input: string): string {
  return scrub(input) as string;
}

// ---------------------------------------------------------------------------
// Parity categories
//
// PARITY = the two paths produce the same output.
// DIVERGE_BASH_ONLY = bash scrubs, JS does not.
// DIVERGE_JS_ONLY   = JS scrubs, bash does not.
// DIVERGE_BOTH      = both scrub but produce different output text.
// ---------------------------------------------------------------------------

/**
 * Categories where bash scrubs but JS does not.
 * These are pinned as it.todo() — bash is the safer (more redactive) path.
 */
const BASH_ONLY_CATEGORIES = new Set(['jwt', 'aws-key', 'aws-secret', 'anthropic-key', 'generic-secret']);

/**
 * Categories where JS scrubs but bash does not.
 * These are pinned as it.todo() — JS is the safer path.
 */
const JS_ONLY_CATEGORIES = new Set(['bearer-hex']);

/**
 * Specific IDs that cross both engines (contain BOTH bearer-hex AND a bash-only pattern).
 * Both sides redact something but produce different output — always a divergence.
 */
const MIXED_DIVERGE_IDS = new Set(['edge-06', 'edge-07', 'edge-08', 'edge-10', 'edge-11']);

/**
 * IDs where the fixture is labeled innocuous/non-scrubbed but bash DOES scrub them
 * due to over-broad pattern matching (false positives from bash's ERE engine).
 *
 * These are bash-over-redaction divergences. Bash is technically "safer" (never leaks)
 * but the false positives mean bash redacts legitimate code/text that JS would not.
 * Documented in PARITY_DIVERGENCE.md.
 */
const BASH_OVERREDACT_IDS = new Set([
  // innocuous-09: "const token = getUserTokenFromContext();" — bash generic-secret pattern
  //   matches "token = getUserTokenFromContext" (token keyword + = + 24-char identifier).
  //   This is a false positive. JS correctly passes through.
  'innocuous-09',
  // edge-13: "AKIAIOSFODNN7EXAMPLE1" — 21-char string. Bash AKIA[0-9A-Z]{16} matches
  //   the first 20 chars ("AKIAIOSFODNN7EXAMPLE"), leaving "1" unredacted.
  //   expect_scrubbed=false in fixture (we expected it NOT to match) but bash does match.
  'edge-13',
  // edge-15: "api_key: AAAA-BBBB-CCCC-DDDD-EEEE-FFFF" — the ERE character class
  //   [A-Za-z0-9_./+=-] includes the hyphen (literal at end of class), so dash-separated
  //   values like AAAA-BBBB-... ARE matched. expect_scrubbed=false was wrong; bash scrubs it.
  'edge-15',
]);

/**
 * IDs where trailing newline is stripped by bash's jq -Rs pipeline.
 * Input ends with \n; jq -Rs strips the trailing newline from the string value.
 * JS preserves the newline. This is a trivial implementation-detail divergence
 * (not a security concern) but breaks byte-equality.
 */
const BASH_NEWLINE_STRIP_IDS = new Set([
  // edge-03: "\t\n" — jq -Rs strips trailing newline; bash returns "\t", JS returns "\t\n".
  'edge-03',
]);

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const describeIfBash = bashAvailable ? describe : describe.skip;

describeIfBash('scrub parity — bash _ingest-transcript.sh --scrub-only vs src/lib/scrub.ts', () => {
  const fixtures = loadFixtures();

  // Report fixture count for CI log.
  it('fixture corpus is loaded (at least 100 entries)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(100);
  });

  // -------------------------------------------------------------------------
  // PARITY TESTS — categories where both engines agree (innocuous + edge
  // entries that contain neither bearer-hex nor bash-only patterns).
  // -------------------------------------------------------------------------

  describe('PARITY — innocuous inputs (neither engine should scrub)', () => {
    const innocuous = fixtures.filter(
      (f) =>
        f.category === 'innocuous' &&
        !MIXED_DIVERGE_IDS.has(f.id) &&
        !BASH_OVERREDACT_IDS.has(f.id) &&
        !BASH_NEWLINE_STRIP_IDS.has(f.id),
    );

    for (const { id, category, input, expect_scrubbed } of innocuous) {
      it(`${category} ${id}: bash and JS produce identical output`, () => {
        const bashOut = runBashScrub(input);
        const jsOut = runJsScrub(input);
        expect(jsOut).toBe(bashOut);

        if (expect_scrubbed) {
          // Both should have redacted something.
          expect(jsOut).not.toBe(input);
        } else {
          // Neither should have changed the input.
          expect(jsOut).toBe(input);
        }
      });
    }
  });

  describe('PARITY — edge inputs with no secrets (both pass through)', () => {
    const cleanEdges = fixtures.filter(
      (f) =>
        f.category === 'edge' &&
        !f.expect_scrubbed &&
        !MIXED_DIVERGE_IDS.has(f.id) &&
        !BASH_OVERREDACT_IDS.has(f.id) &&
        !BASH_NEWLINE_STRIP_IDS.has(f.id),
    );

    for (const { id, category, input } of cleanEdges) {
      it(`${category} ${id}: bash and JS both pass through unchanged`, () => {
        const bashOut = runBashScrub(input);
        const jsOut = runJsScrub(input);
        expect(jsOut).toBe(bashOut);
        expect(jsOut).toBe(input);
      });
    }
  });

  // -------------------------------------------------------------------------
  // DIVERGENCE — bash scrubs, JS does not.
  // These are pinned as it.todo() per spec §5.3 instruction.
  // Bash is the safer (more redactive) path for these categories.
  // Resolution: Slice 4 must call src/lib/scrub.ts before piping to bash
  // OR extend BEARER_RE in scrub.ts to cover these patterns.
  // See PARITY_DIVERGENCE.md for full analysis.
  // -------------------------------------------------------------------------

  describe('DIVERGENCE — bash scrubs JWT; JS does not (bash is safer)', () => {
    const jwtEntries = fixtures.filter(
      (f) => f.category === 'jwt' && f.expect_scrubbed,
    );

    for (const { id, category, input } of jwtEntries) {
      it.todo(`[diverge:bash-only] ${category} ${id}: bash redacts JWT, JS leaves plain`);
    }

    // Verify empirically: bash output differs from input; JS output equals input.
    it('empirical: bash redacts JWT, JS does NOT (representative sample with long segments)', () => {
      // jwt-02 has segments long enough to satisfy eyJ[A-Za-z0-9_-]{20,} on each part.
      // jwt-01 has short segments (header=20 chars, payload=19 chars — below the {20,} threshold).
      // Use jwt-02 as it reliably triggers the bash pattern.
      const sample = fixtures.find((f) => f.id === 'jwt-02')!;
      const bashOut = runBashScrub(sample.input);
      const jsOut = runJsScrub(sample.input);
      // Bash must have redacted.
      expect(bashOut).not.toBe(sample.input);
      expect(bashOut).toContain('[redacted:jwt]');
      // JS must NOT have redacted (confirms divergence, not a pass).
      expect(jsOut).toBe(sample.input);
      // Outputs differ — the divergence is real.
      expect(jsOut).not.toBe(bashOut);
    });
  });

  describe('DIVERGENCE — bash scrubs AWS key IDs; JS does not (bash is safer)', () => {
    const awsKeyEntries = fixtures.filter(
      (f) => f.category === 'aws-key' && f.expect_scrubbed,
    );

    for (const { id, category, input } of awsKeyEntries) {
      it.todo(`[diverge:bash-only] ${category} ${id}: bash redacts AWS key ID, JS leaves plain`);
    }

    it('empirical: bash redacts AKIA key, JS does NOT', () => {
      const sample = awsKeyEntries[0]!;
      const bashOut = runBashScrub(sample.input);
      const jsOut = runJsScrub(sample.input);
      expect(bashOut).toContain('[redacted:aws-key]');
      expect(jsOut).toBe(sample.input);
      expect(jsOut).not.toBe(bashOut);
    });
  });

  describe('DIVERGENCE — bash scrubs AWS secrets via generic pattern; JS does not (bash is safer)', () => {
    const awsSecretEntries = fixtures.filter(
      (f) => f.category === 'aws-secret' && f.expect_scrubbed,
    );

    for (const { id, category, input } of awsSecretEntries) {
      it.todo(`[diverge:bash-only] ${category} ${id}: bash redacts AWS secret, JS leaves plain`);
    }

    it('empirical: bash redacts secret=..., JS does NOT', () => {
      // aws-secret-01 ("aws_secret_access_key=...") does NOT match the bash generic pattern:
      //   the keyword alternation is (api[_-]?key|secret|password|token) and after finding
      //   "secret" inside "aws_secret_access_key", the next char is "_" which is NOT in
      //   [[:space:]]*[:=] — so the pattern requires the keyword to be followed immediately
      //   by optional whitespace then : or =.
      // aws-secret-02 uses "secret=..." which does match.
      const sample = fixtures.find((f) => f.id === 'aws-secret-02')!;
      const bashOut = runBashScrub(sample.input);
      const jsOut = runJsScrub(sample.input);
      expect(bashOut).toContain('[redacted:generic-secret]');
      expect(jsOut).toBe(sample.input);
      expect(jsOut).not.toBe(bashOut);
    });
  });

  describe('DIVERGENCE — bash scrubs Anthropic keys; JS does not (bash is safer)', () => {
    const anthropicEntries = fixtures.filter(
      (f) => f.category === 'anthropic-key' && f.expect_scrubbed,
    );

    for (const { id, category, input } of anthropicEntries) {
      it.todo(`[diverge:bash-only] ${category} ${id}: bash redacts Anthropic key, JS leaves plain`);
    }

    it('empirical: bash redacts sk-ant-api03-..., JS does NOT', () => {
      const sample = anthropicEntries[0]!;
      const bashOut = runBashScrub(sample.input);
      const jsOut = runJsScrub(sample.input);
      expect(bashOut).toContain('[redacted:anthropic-key]');
      expect(jsOut).toBe(sample.input);
      expect(jsOut).not.toBe(bashOut);
    });
  });

  describe('DIVERGENCE — bash scrubs generic api_key/secret/password/token; JS does not (bash is safer)', () => {
    const genericEntries = fixtures.filter(
      (f) => f.category === 'generic-secret' && f.expect_scrubbed,
    );

    for (const { id, category, input } of genericEntries) {
      it.todo(`[diverge:bash-only] ${category} ${id}: bash redacts generic secret, JS leaves plain`);
    }

    it('empirical: bash redacts api_key=..., JS does NOT', () => {
      const sample = genericEntries[0]!;
      const bashOut = runBashScrub(sample.input);
      const jsOut = runJsScrub(sample.input);
      expect(bashOut).toContain('[redacted:generic-secret]');
      expect(jsOut).toBe(sample.input);
      expect(jsOut).not.toBe(bashOut);
    });
  });

  // -------------------------------------------------------------------------
  // DIVERGENCE — JS scrubs Bearer hex; bash does not.
  // JS is the safer path for these inputs.
  // Resolution: Slice 4 hook shim must pre-scrub via JS before piping to bash
  // (the new ingest-transcript Bun CLI handles this automatically because it
  // calls scrub() per turn before sending to the provider).
  // -------------------------------------------------------------------------

  describe('DIVERGENCE — JS scrubs Bearer hex tokens; bash does NOT (JS is safer)', () => {
    const bearerEntries = fixtures.filter(
      (f) => f.category === 'bearer-hex' && f.expect_scrubbed,
    );

    for (const { id, category, input } of bearerEntries) {
      it.todo(`[diverge:js-only] ${category} ${id}: JS redacts Bearer hex, bash leaves plain`);
    }

    it('empirical: JS redacts Bearer hex, bash does NOT', () => {
      const sample = bearerEntries[0]!;
      const bashOut = runBashScrub(sample.input);
      const jsOut = runJsScrub(sample.input);
      // JS must have redacted.
      expect(jsOut).toContain('[REDACTED:bearer]');
      expect(jsOut).not.toBe(sample.input);
      // Bash must NOT have redacted.
      expect(bashOut).toBe(sample.input);
      // Outputs differ — the divergence is real.
      expect(jsOut).not.toBe(bashOut);
    });
  });

  // -------------------------------------------------------------------------
  // DIVERGENCE — mixed inputs containing patterns from both engines.
  // Both engines redact something, but produce different intermediate text.
  // These can never be parity-identical without a unified scrub layer.
  // -------------------------------------------------------------------------

  describe('DIVERGENCE — mixed inputs (bash-only + JS-only patterns co-present)', () => {
    const mixedEntries = fixtures.filter((f) => MIXED_DIVERGE_IDS.has(f.id));

    for (const { id, category, input } of mixedEntries) {
      it.todo(`[diverge:both] ${category} ${id}: both engines redact something but produce different output`);
    }

    it('empirical: edge-06 (AKIA + Bearer) — bash redacts AKIA, JS redacts Bearer, outputs differ', () => {
      const entry = fixtures.find((f) => f.id === 'edge-06')!;
      const bashOut = runBashScrub(entry.input);
      const jsOut = runJsScrub(entry.input);
      expect(bashOut).toContain('[redacted:aws-key]');
      expect(jsOut).toContain('[REDACTED:bearer]');
      expect(jsOut).not.toBe(bashOut);
    });
  });

  // -------------------------------------------------------------------------
  // DIVERGENCE — bash over-redacts via false-positive pattern matches.
  // JS correctly passes these through. Bash is over-cautious (not a leak risk)
  // but will mangle legitimate code/text in transcript turns.
  // Resolution: Slice 4 new CLI path uses only JS scrub, eliminating these.
  // -------------------------------------------------------------------------

  describe('DIVERGENCE — bash false-positive over-redaction; JS passes through (JS is correct)', () => {
    const overRedactEntries = fixtures.filter((f) => BASH_OVERREDACT_IDS.has(f.id));

    for (const { id, category, input } of overRedactEntries) {
      it.todo(`[diverge:bash-overredact] ${category} ${id}: bash scrubs legitimate text; JS correctly passes through`);
    }

    it('empirical: innocuous-09 — bash mangles function call containing "token =", JS does not', () => {
      const entry = fixtures.find((f) => f.id === 'innocuous-09')!;
      const bashOut = runBashScrub(entry.input);
      const jsOut = runJsScrub(entry.input);
      // Bash over-redacts the function call.
      expect(bashOut).toContain('[redacted:generic-secret]');
      // JS correctly passes through.
      expect(jsOut).toBe(entry.input);
      // Outputs differ.
      expect(jsOut).not.toBe(bashOut);
    });
  });

  // -------------------------------------------------------------------------
  // DIVERGENCE — bash jq -Rs strips trailing newline from output.
  // JS preserves trailing newlines. This is an implementation detail of the
  // bash pipeline (jq -Rs parses all stdin as a single string, then `jq`
  // serialises it — but the trailing newline from printf '%s' is stripped
  // by the jq string serialiser). Not a security concern; noted for parity.
  // Resolution: new CLI path doesn't use this pipeline at all.
  // -------------------------------------------------------------------------

  describe('DIVERGENCE — bash strips trailing newline via jq -Rs; JS preserves it', () => {
    const newlineEntries = fixtures.filter((f) => BASH_NEWLINE_STRIP_IDS.has(f.id));

    for (const { id, category } of newlineEntries) {
      it.todo(`[diverge:newline-strip] ${category} ${id}: bash strips trailing \\n; JS preserves it`);
    }

    it('empirical: edge-03 (\\t\\n) — bash returns "\\t", JS returns "\\t\\n"', () => {
      const entry = fixtures.find((f) => f.id === 'edge-03')!;
      const bashOut = runBashScrub(entry.input);
      const jsOut = runJsScrub(entry.input);
      // Bash strips the trailing newline.
      expect(bashOut).toBe('\t');
      // JS preserves the exact input.
      expect(jsOut).toBe(entry.input);
      // They differ.
      expect(jsOut).not.toBe(bashOut);
    });
  });

  // -------------------------------------------------------------------------
  // NON-MATCH control set — inputs that LOOK secret-adjacent but don't match.
  // Both engines must pass them through unchanged.
  // -------------------------------------------------------------------------

  describe('PARITY — non-matching patterns (both engines pass through)', () => {
    // Entries where expect_scrubbed=false regardless of category.
    // Excludes mixed-diverge IDs and IDs with known divergence behaviours.
    const nonMatchEntries = fixtures.filter(
      (f) =>
        !f.expect_scrubbed &&
        !MIXED_DIVERGE_IDS.has(f.id) &&
        !BASH_OVERREDACT_IDS.has(f.id) &&
        !BASH_NEWLINE_STRIP_IDS.has(f.id),
    );

    for (const { id, category, input } of nonMatchEntries) {
      it(`${category} ${id}: both engines pass through unchanged`, () => {
        const bashOut = runBashScrub(input);
        const jsOut = runJsScrub(input);
        // Both should leave the input unchanged.
        expect(bashOut).toBe(input);
        expect(jsOut).toBe(input);
        // And therefore agree with each other.
        expect(jsOut).toBe(bashOut);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Bash unavailable — emit a single informational test.
// ---------------------------------------------------------------------------

if (!bashAvailable) {
  describe('scrub parity — bash unavailable', () => {
    it.skip('bash not found on PATH — parity suite skipped (bash required for --scrub-only)', () => {
      // intentionally empty
    });
  });
}
