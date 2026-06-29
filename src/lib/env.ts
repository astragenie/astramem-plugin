/**
 * env.ts — centralised env-var resolution with alias support + deprecation tracking.
 *
 * Key behaviours:
 *   - Canonical var wins over any alias.
 *   - Aliases checked in order; first non-empty value (passing optional predicate) wins.
 *   - One-shot stderr deprecation warning per alias name per process.
 *   - Warning suppressed when MEMORY_DEPRECATION_OPT_OUT=1.
 *   - Hit counts accumulate per alias name for `astramem doctor` (Slice 6).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EnvSpec {
  /** Canonical env-var name. */
  canonical: string;
  /** Optional list of legacy aliases checked AFTER canonical. */
  aliases?: string[];
  /** Optional default if neither canonical nor any alias is set. */
  default?: string;
  /**
   * Optional predicate — alias only counts if value matches.
   * Used for URL alias disambiguation (e.g. ASTRAMEMORY_API_URL may be local or SaaS).
   */
  aliasPredicate?: (value: string) => boolean;
}

export interface EnvResolution {
  value: string | undefined;
  source: 'canonical' | 'alias' | 'default' | 'absent';
  /** Which alias matched, if source === 'alias'. */
  aliasUsed?: string;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Alias names for which a deprecation warning has already been emitted this process. */
const _warnedAliases = new Set<string>();

/** Accumulated hit counts per alias name (for `astramem doctor` in Slice 6). */
const _hitCounts = new Map<string, number>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve an env var by spec.
 *
 * Resolution order:
 *   1. process.env[spec.canonical] — if non-empty, return canonical.
 *   2. For each alias in spec.aliases (in order):
 *        - If non-empty AND (no aliasPredicate OR predicate passes):
 *            - Increment hit count.
 *            - Emit one-shot stderr deprecation warning (unless OPT_OUT=1).
 *            - Return alias.
 *   3. If spec.default defined, return default.
 *   4. Return absent.
 */
export function resolveEnv(spec: EnvSpec): EnvResolution {
  // 1. Canonical wins.
  const canonicalVal = process.env[spec.canonical];
  if (canonicalVal !== undefined && canonicalVal !== '') {
    return { value: canonicalVal, source: 'canonical' };
  }

  // 2. Try aliases in order.
  for (const alias of spec.aliases ?? []) {
    const aliasVal = process.env[alias];
    if (aliasVal === undefined || aliasVal === '') continue;
    if (spec.aliasPredicate && !spec.aliasPredicate(aliasVal)) continue;

    // Count every hit, warn once per alias name per process.
    _hitCounts.set(alias, (_hitCounts.get(alias) ?? 0) + 1);

    if (!_warnedAliases.has(alias) && process.env['MEMORY_DEPRECATION_OPT_OUT'] !== '1') {
      _warnedAliases.add(alias);
      process.stderr.write(
        `[astramem] DEPRECATED env var "${alias}" → use "${spec.canonical}" (set MEMORY_DEPRECATION_OPT_OUT=1 to silence)\n`,
      );
    }

    return { value: aliasVal, source: 'alias', aliasUsed: alias };
  }

  // 3. Default.
  if (spec.default !== undefined) {
    return { value: spec.default, source: 'default' };
  }

  // 4. Absent.
  return { value: undefined, source: 'absent' };
}

/**
 * Return a snapshot of deprecation hit counts keyed by alias name.
 * Used by `astramem doctor` (Slice 6).
 */
export function getDeprecationHits(): Record<string, number> {
  return Object.fromEntries(_hitCounts);
}

/**
 * Reset hit counts and warning-suppression state.
 * TEST-ONLY — do not call in production code.
 */
export function _resetEnvState(): void {
  _warnedAliases.clear();
  _hitCounts.clear();
}
