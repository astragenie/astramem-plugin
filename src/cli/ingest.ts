// astramem ingest — fire-and-forget ingest subcommand.
// Validates payload via IngestPayloadSchema, resolves provider via selector,
// races the call against a 2s timeout. Always exits 0 — errors go to ingest log.
import { IngestPayloadSchema } from '../contracts/wire.ts';
import type { Provider } from '../contracts/selector.ts';
import type { MemoryProvider } from '../contracts/provider.ts';
import { appendIngestLog } from '../lib/log.ts';
import { resolveProvider } from '../lib/selector.ts';

/** Injected opts — real CLI passes provider flag; tests inject a mock provider. */
export interface IngestOpts {
  /** Provider override from --provider flag. */
  provider?: Provider;
  /** Injected provider (tests only — bypasses selector). */
  _provider?: MemoryProvider;
}

/**
 * Run the `astramem ingest` subcommand.
 *
 * Parses --json <payload> from args.
 * Zod-validates the payload against IngestPayloadSchema.
 * Fires ingest at the selected provider, races against a 2s timeout.
 * ALWAYS returns 0 — errors are logged, never surfaced as exit codes.
 */
export async function runIngest(args: string[], opts: IngestOpts = {}): Promise<number> {
  // Parse --json <payload>
  let rawJson: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && i + 1 < args.length) {
      rawJson = args[i + 1];
      break;
    }
  }

  if (!rawJson) {
    appendIngestLog('ingest: missing --json argument');
    process.stderr.write('astramem ingest: --json <payload> is required\n');
    return 0; // fire-and-forget — still exit 0
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    const msg = `ingest: invalid JSON — ${(e as Error).message}`;
    appendIngestLog(msg);
    process.stderr.write(`astramem ingest: ${msg}\n`);
    return 0;
  }

  // Validate schema
  const result = IngestPayloadSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => i.message).join(', ');
    const msg = `ingest: payload schema validation failed — ${issues}`;
    appendIngestLog(msg);
    process.stderr.write(`astramem ingest: ${msg}\n`);
    return 0;
  }

  const payload = result.data;

  // Resolve provider
  let provider: MemoryProvider;
  try {
    if (opts._provider) {
      provider = opts._provider;
    } else {
      const sel = await resolveProvider({ flag: opts.provider });
      provider = sel.provider;
    }
  } catch (e) {
    const msg = `ingest: selector error — ${(e as Error).message}`;
    appendIngestLog(msg);
    return 0;
  }

  // Fire-and-forget: race ingest call against 2s timeout
  const call = provider.ingest(payload);
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000));
  try {
    await Promise.race([call, timeout]);
  } catch (e) {
    const msg = `ingest: provider error — ${(e as Error).message}`;
    appendIngestLog(msg);
    // Intentionally swallow — fire-and-forget
  }

  return 0;
}
