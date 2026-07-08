/**
 * save-marker.ts — inline "🧠 memory saved" marker (issue #40).
 *
 * Pure, dependency-light formatting core shared by every deterministic save
 * path (the `astramem remember` CLI, and the PostToolUse hook shim for the
 * daemon's `remember` MCP tool — see hooks/scripts/remember-marker.sh).
 *
 * Scope note: transcript-capture paths (PreCompact/SubagentStop →
 * `ingestTranscript()`) are OUT OF SCOPE here. `ingestTranscript()` returns
 * `Promise<void>` and the daemon distills atoms asynchronously, so there is
 * no synchronous per-type saved count to format at hook-fire time. See
 * CLAUDE.md's "Inline save marker" section for the deferred follow-up.
 *
 * Scrub-safe by construction: this module only ever handles counts and type
 * names (both drawn from the canonical memory-type enum), never memory text
 * — nothing here needs to run through scrubWithLabels().
 */

/**
 * Canonical memory-type enum (#27 — ADR-005 / U4 contract-unification),
 * in registry order. Mirrors `MemoryTypeSchema` (src/contracts/wire.ts),
 * kept as a plain literal list here rather than importing the Zod schema so
 * this module stays dependency-light — the ratified 10-value set is stable,
 * and an unlisted/future type falls back to the 🧠 emoji below rather than
 * failing.
 */
const CANONICAL_TYPE_ORDER = [
  'decision',
  'fact',
  'lesson',
  'command',
  'todo',
  'note',
  'event',
  'preference',
  'task_result',
  'summary',
] as const;

/** Per-type emoji. Unknown/unlisted types fall back to 🧠 — see module doc. */
export const SAVE_MARKER_EMOJI: Record<string, string> = {
  decision: '🧭',
  fact: '💡',
  lesson: '📝',
  command: '⚙️',
  todo: '📋',
  note: '📌',
  event: '📅',
  preference: '⭐',
  task_result: '✅',
  summary: '🗒️',
};

const UNKNOWN_TYPE_EMOJI = '🧠';

/**
 * Format the inline save marker for a batch of saved atoms, grouped by type.
 * Zero-suppressed: returns null when the total across all types is 0 (no
 * marker should be emitted for a no-op save).
 *
 * Segment order: canonical enum order first, then any types outside the
 * registry (unknown-fallback emoji) in the order they appear in `byType`.
 * Only non-zero counts get a segment.
 */
export function formatSaveMarker(byType: Record<string, number>): string | null {
  const total = Object.values(byType).reduce((sum, n) => sum + n, 0);
  if (total <= 0) return null;

  const orderedTypes = [
    ...CANONICAL_TYPE_ORDER.filter((t) => (byType[t] ?? 0) > 0),
    ...Object.keys(byType).filter((t) => !(CANONICAL_TYPE_ORDER as readonly string[]).includes(t) && (byType[t] ?? 0) > 0),
  ];

  const segments = orderedTypes.map((t) => {
    const emoji = SAVE_MARKER_EMOJI[t] ?? UNKNOWN_TYPE_EMOJI;
    return `${emoji} ${byType[t]} ${t}`;
  });

  return `🧠 astramem · saved ${total} (${segments.join(' · ')})`;
}

/**
 * Whether the inline save marker is enabled. Default ON — set
 * `MEMORY_SAVE_MARKER=0` to opt out. Inverted from MEMORY_EXPORT_MD_ENABLE's
 * default-off style deliberately: this marker never writes to the repo, it
 * only echoes a transient hook systemMessage, so the higher-risk default-off
 * posture that export-md needs doesn't apply here.
 */
export function saveMarkerEnabled(env: NodeJS.ProcessEnv): boolean {
  return env['MEMORY_SAVE_MARKER'] !== '0';
}
