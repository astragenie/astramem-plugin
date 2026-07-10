/**
 * wire-probe.ts — startup wire-version compatibility probe (FEAT 4a backlog M1).
 *
 * Calls the resolved backend's GET /version and compares its advertised
 * wire_versions_supported against the per-domain contract generations this
 * plugin build speaks.
 *
 * Contract shape (per U6-cloud, confirmed against the shipped cloud
 * GET /version as of this writing):
 *   wire_versions_supported: string[]   — per-domain "<domain>@<gen>" entries,
 *                                          e.g. ["atom@1","retrieval@1","sync@1","capture@1"]
 *   schema_version: string|number        — coarse overall generation marker.
 *                                          NOT the primary compatibility signal —
 *                                          the four domains version independently,
 *                                          so this is surfaced for diagnostics only.
 *
 * Canonical domain ids (matches astramem-local's contracts/schemas/*.v1 —
 * repo-of-record for the cross-system wire contract): atom, retrieval, sync,
 * capture. Some backends (older local-daemon builds observed at the time of
 * writing) advertise a flat legacy scheme instead (e.g. ["v0.0","v1.0"]) or a
 * prefixed domain spelling (e.g. "astramem-sync@1", "astramem/atom@1") — both
 * are normalized/tolerated below rather than treated as a hard failure.
 *
 * Defensive by design — a backend that doesn't yet expose /version, whose
 * /version omits wire_versions_supported, or whose entries don't match the
 * "<domain>@<gen>" shape at all (i.e. hasn't adopted domain-based versioning
 * yet) is classified 'legacy' (unknown-but-tolerated), NOT a hard failure.
 *
 * Only a backend that HAS adopted domain-based versioning but is missing (or
 * on a different generation of) a domain this plugin actually speaks is a
 * genuine incompatibility. That case fails LOUDLY — checkWireCompat() throws
 * WireIncompatibilityError naming expected vs. got — rather than degrading
 * silently.
 */
import { z } from 'zod';
import { DeterministicError } from './errors.ts';
import { unrefTimer } from './abort.ts';

// ---------------------------------------------------------------------------
// Domains this plugin build speaks, and the generation of each it expects.
//   atom@1      — remember() / ingest() (storing atomic memory items)
//   retrieval@1 — recall() (hybrid search)
//   capture@1   — ingestTranscript() (transcript capture envelope)
// The plugin does not itself implement the sync@1 protocol (that's
// astramem-local's local<->local sync concern — see CLAUDE.md "No sync
// bridge"), so it is deliberately excluded from this list: an absent sync@N
// entry is not a plugin-relevant incompatibility.
// ---------------------------------------------------------------------------
export const PLUGIN_WIRE_DOMAINS_SUPPORTED: readonly string[] = ['atom@1', 'retrieval@1', 'capture@1'];

/** Prefixes observed on older/divergent backends — stripped before matching. */
const KNOWN_PREFIXES = ['astramem-', 'astramem/'];

/** Matches the canonical "<domain>@<gen>" shape, e.g. "atom@1". */
const DOMAIN_VERSION_RE = /^[a-z][a-z0-9_]*@\d+$/;

function normalizeDomainEntry(entry: string): string {
  for (const prefix of KNOWN_PREFIXES) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  }
  return entry;
}

// Tolerant schema — every field optional. A backend's GET /version may still
// be the bare legacy shape ({version, gitSha, builtAt, service, timestamp} —
// an older SaaS HealthController.Version()) or the full FEAT-4a contract
// ({name, version, wire_versions_supported, schema_version, ts}).
// .passthrough() tolerates either, plus any future additive fields, without
// rejecting the response.
const VersionResponseSchema = z
  .object({
    wire_versions_supported: z.array(z.string()).optional(),
    schema_version: z.union([z.number(), z.string()]).optional(),
    version: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export type VersionResponse = z.infer<typeof VersionResponseSchema>;

export type WireCompatStatus = 'compatible' | 'incompatible' | 'legacy' | 'unreachable';

export interface WireCompatResult {
  status: WireCompatStatus;
  providerName: string;
  baseUrl: string;
  remote?: VersionResponse;
  /** Domains this plugin speaks that the backend's manifest does not cover
   * at the expected generation. Only populated when status === 'incompatible'. */
  missingDomains?: string[];
  /** Present when status is 'legacy' | 'unreachable' — probe/parse/shape detail. */
  error?: string;
}

/**
 * Thrown when a backend HAS adopted domain-based wire versioning but is
 * missing (or on a mismatched generation of) a domain this plugin speaks.
 * Not retryable — the mismatch persists until the plugin or the backend is
 * upgraded, so this extends DeterministicError (excluded from
 * ingest-transcript's TransientError-only retry/enqueue path).
 */
export class WireIncompatibilityError extends DeterministicError {
  constructor(message: string) {
    super(message);
    this.name = 'WireIncompatibilityError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

async function fetchVersion(baseUrl: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // unref() so an abandoned probe cannot keep the event loop alive on its own
  // after a caller's own shorter deadline fires (issue #29).
  unrefTimer(timer);
  try {
    return await fetch(`${baseUrl}/version`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a backend's GET /version and classify wire compatibility.
 * Never throws — network failures, non-2xx responses, and unparseable
 * bodies all resolve to status 'unreachable' rather than rejecting.
 */
export async function probeWireCompat(
  providerName: string,
  baseUrl: string,
  timeoutMs = 3000,
): Promise<WireCompatResult> {
  let json: unknown;
  try {
    const res = await fetchVersion(baseUrl, timeoutMs);
    if (!res.ok) {
      return {
        status: 'unreachable',
        providerName,
        baseUrl,
        error: `GET /version: ${res.status} ${res.statusText || ''}`.trim(),
      };
    }
    json = await res.json();
  } catch (err: unknown) {
    const message =
      (err as Error)?.name === 'AbortError'
        ? `GET /version timed out after ${timeoutMs}ms`
        : `GET /version failed: ${(err as Error)?.message ?? String(err)}`;
    return { status: 'unreachable', providerName, baseUrl, error: message };
  }

  const parsed = VersionResponseSchema.safeParse(json);
  if (!parsed.success) {
    return {
      status: 'legacy',
      providerName,
      baseUrl,
      error: 'GET /version returned an unrecognized shape',
    };
  }

  const remote = parsed.data;
  if (remote.wire_versions_supported === undefined) {
    // Backend predates the FEAT-4a wire-version contract — legacy/unknown.
    return { status: 'legacy', providerName, baseUrl, remote };
  }

  const normalized = remote.wire_versions_supported.map(normalizeDomainEntry);
  const hasDomainScheme = normalized.some((v) => DOMAIN_VERSION_RE.test(v));
  if (!hasDomainScheme) {
    // Array present but doesn't match "<domain>@<gen>" at all — e.g. an
    // older local daemon still advertising flat ["v0.0","v1.0"]. Backend
    // hasn't adopted domain-based versioning yet; tolerate as legacy.
    return {
      status: 'legacy',
      providerName,
      baseUrl,
      remote,
      error: `wire_versions_supported did not match the domain@gen shape: [${remote.wire_versions_supported.join(', ')}]`,
    };
  }

  const normalizedSet = new Set(normalized);
  const missingDomains = PLUGIN_WIRE_DOMAINS_SUPPORTED.filter((d) => !normalizedSet.has(d));
  if (missingDomains.length > 0) {
    return {
      status: 'incompatible',
      providerName,
      baseUrl,
      remote,
      missingDomains,
    };
  }

  return { status: 'compatible', providerName, baseUrl, remote };
}

/** Build the loud, "expected vs. got" mismatch message for an 'incompatible' result. */
function buildIncompatibilityMessage(result: WireCompatResult): string {
  const got = result.remote?.wire_versions_supported?.join(', ') || '(none)';
  const expected = PLUGIN_WIRE_DOMAINS_SUPPORTED.join(', ');
  const missing = (result.missingDomains ?? []).join(', ');
  const schemaNote =
    result.remote?.schema_version !== undefined
      ? ` (backend schema_version=${result.remote.schema_version})`
      : '';
  return (
    `Wire version mismatch with ${result.providerName} backend at ${result.baseUrl}: ` +
    `plugin speaks [${expected}], backend supports [${got}]${schemaNote}. ` +
    `Missing/mismatched domain(s): [${missing}]. ` +
    `Upgrade the plugin or the backend so their wire domains overlap.`
  );
}

/**
 * Throws WireIncompatibilityError when result.status === 'incompatible'; a
 * no-op for every other status. Exported so callers that hold a
 * WireCompatResult produced some other way (e.g. an injected test stub that
 * returns a status object rather than throwing) still get the same
 * fail-loudly enforcement as checkWireCompat()'s own inline probe+throw.
 */
export function assertWireCompatible(result: WireCompatResult): void {
  if (result.status === 'incompatible') {
    throw new WireIncompatibilityError(buildIncompatibilityMessage(result));
  }
}

/**
 * Probe + enforce. Throws WireIncompatibilityError on a genuine mismatch
 * (naming expected vs. got); returns the result without throwing for
 * 'compatible' | 'legacy' | 'unreachable' — callers decide whether those
 * non-fatal statuses are worth a warning.
 */
export async function checkWireCompat(
  providerName: string,
  baseUrl: string,
  timeoutMs?: number,
): Promise<WireCompatResult> {
  const result = await probeWireCompat(providerName, baseUrl, timeoutMs);
  assertWireCompatible(result);
  return result;
}
