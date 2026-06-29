/**
 * scrub.ts — recursive bearer / secret redaction before logging.
 *
 * Rules:
 *  1. Strings: replace /Bearer\s+[A-Fa-f0-9]{32,128}/g → '[REDACTED:bearer]'
 *  2. Object keys matching /api[_-]?key|token|bearer|secret|password/i:
 *       replace the VALUE with '[REDACTED]'
 *  3. Arrays: map element-wise through scrub().
 *  4. scrubError(err): scrub() on a serialised error representation;
 *       truncate any string field > 200 chars.
 */

export const BEARER_RE = /Bearer\s+[A-Fa-f0-9]{32,128}/gi;
const SENSITIVE_KEY_RE = /api[_-]?key|token|bearer|secret|password/i;
const MAX_STR_LEN = 200;

/**
 * Recursively scrub bearer tokens and sensitive keys from an unknown value.
 * Safe to call on any JSON-serialisable input. Non-JSON values pass through.
 */
export function scrub(input: unknown): unknown {
  if (typeof input === 'string') {
    return input.replace(BEARER_RE, '[REDACTED:bearer]');
  }

  if (Array.isArray(input)) {
    return input.map(scrub);
  }

  if (input !== null && typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = scrub(val);
      }
    }
    return result;
  }

  // Numbers, booleans, null, undefined — pass through unchanged.
  return input;
}

/**
 * Scrub an error value for safe logging.
 * Serialises the error to a plain object, scrubs it, then truncates
 * any remaining string values > 200 chars (to prevent transcript bloat).
 */
export function scrubError(err: unknown): unknown {
  const serialised = serializeError(err);
  const scrubbed = scrub(serialised);
  return truncateStrings(scrubbed, MAX_STR_LEN);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(err.cause !== undefined ? { cause: serializeError(err.cause) } : {}),
    };
  }
  if (typeof err === 'string') {
    return { message: err };
  }
  if (err !== null && typeof err === 'object') {
    // Spread enumerable properties.
    return { ...err as Record<string, unknown> };
  }
  return { value: String(err) };
}

function truncateStrings(input: unknown, maxLen: number): unknown {
  if (typeof input === 'string') {
    return input.length > maxLen ? input.slice(0, maxLen) + '…[truncated]' : input;
  }
  if (Array.isArray(input)) {
    return input.map((el) => truncateStrings(el, maxLen));
  }
  if (input !== null && typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
      result[key] = truncateStrings(val, maxLen);
    }
    return result;
  }
  return input;
}
