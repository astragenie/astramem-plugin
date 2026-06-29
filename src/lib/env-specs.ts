/**
 * env-specs.ts — single source of truth for env-var canonical names + aliases.
 *
 * Import ENV here; call resolveEnv(ENV.<key>) at the use-site.
 * Do NOT scatter process.env reads across the codebase — add them here instead.
 *
 * Removal schedule for legacy aliases: NLT v0.8.0 (see FEAT 4a §4.2).
 */
import type { EnvSpec } from './env.ts';

/**
 * Matches localhost-ish URLs:
 *   http://127.0.0.1:7777  ✓
 *   http://localhost:7777   ✓
 *   http://0.0.0.0:7777    ✓
 *   https://api.example.com ✗
 */
const LOCAL_URL_PATTERN = /^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::\d+)?(?:\/|$)/;

/**
 * Registry of all env-var specs for the astramem plugin.
 *
 * Each key is a logical name used in code; the value is the EnvSpec consumed
 * by resolveEnv().  Callers MUST import ENV and use resolveEnv(ENV.<key>)
 * rather than reading process.env directly.
 */
export const ENV: Record<string, EnvSpec> = {
  /**
   * Local daemon URL.
   * ASTRAMEMORY_API_URL is shared with apiUrlSaas but is routed here when its
   * value matches localhost-ish patterns.  aliasPredicate enforces the split.
   */
  apiUrlLocal: {
    canonical: 'MEMORY_API_URL_LOCAL',
    aliases: ['ASTRAMEMORY_API_URL'],
    aliasPredicate: (v) => LOCAL_URL_PATTERN.test(v),
    default: 'http://127.0.0.1:7777',
  },

  /**
   * SaaS gateway URL.
   * ASTRAMEMORY_API_URL is shared with apiUrlLocal but is routed here when its
   * value does NOT match localhost-ish patterns.
   */
  apiUrlSaas: {
    canonical: 'MEMORY_API_URL_SAAS',
    aliases: ['MEMORY_API_URL', 'ASTRAMEMORY_API_URL'],
    aliasPredicate: (v) => !LOCAL_URL_PATTERN.test(v),
  },

  /**
   * Provider hint: 'local' | 'saas'.
   * No aliases — this name has been stable since Wave 3.
   */
  provider: {
    canonical: 'ASTRAMEM_PROVIDER',
    aliases: [],
  },

  /**
   * Bearer token for the local daemon.
   * Resolution order inside secrets.ts:
   *   1. <unifiedConfigDir>/secrets.env  MEMORY_BEARER= line  (file-first — unchanged)
   *   2. resolveEnv(ENV.bearerLocal) picks up MEMORY_BEARER env or ASTRAMEMORY_API_KEY alias.
   */
  bearerLocal: {
    canonical: 'MEMORY_BEARER',
    aliases: ['ASTRAMEMORY_API_KEY'],
  },

  /**
   * Bearer token for the SaaS gateway.
   * The Clerk OIDC path (memory-refresh) is preferred at runtime; this is the
   * static env fallback until v0.7.0 adds OIDC inside SaasProvider.
   */
  bearerSaas: {
    canonical: 'MEMORY_BEARER',
    aliases: ['ASTRAMEMORY_API_KEY'],
  },

  /** Max turns kept in the session-end transcript ingest. */
  sessionEndMaxTurns: {
    canonical: 'MEMORY_SESSIONEND_MAX_TURNS',
    aliases: ['MEMORY_SESSION_MAX_TURNS'],
    default: '20',
  },

  /** Max chars kept in the session-end transcript ingest. */
  sessionEndMaxChars: {
    canonical: 'MEMORY_SESSIONEND_MAX_CHARS',
    aliases: ['MEMORY_SESSION_MAX_CHARS'],
    default: '12000',
  },

  /** Max turns kept in the pre-compact transcript ingest. */
  preCompactMaxTurns: {
    canonical: 'MEMORY_PRECOMPACT_MAX_TURNS',
    aliases: [],
    default: '20',
  },

  /** Max chars kept in the pre-compact transcript ingest. */
  preCompactMaxChars: {
    canonical: 'MEMORY_PRECOMPACT_MAX_CHARS',
    aliases: [],
    default: '12000',
  },

  /** Max turns kept in the subagent-stop transcript ingest. */
  subagentMaxTurns: {
    canonical: 'MEMORY_SUBAGENT_MAX_TURNS',
    aliases: [],
    default: '20',
  },

  /** Max chars kept in the subagent-stop transcript ingest. */
  subagentMaxChars: {
    canonical: 'MEMORY_SUBAGENT_MAX_CHARS',
    aliases: [],
    default: '12000',
  },
};
