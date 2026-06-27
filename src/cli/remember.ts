// astramem remember — store a new memory item.
// Resolves provider, calls provider.remember(req).
// Exit 0 on success, exit 3 on backend error.
import { IngestPayloadSchema } from '../contracts/wire.ts';
import type { Provider } from '../contracts/selector.ts';
import type { MemoryProvider } from '../contracts/provider.ts';
import { resolveProvider } from '../lib/selector.ts';

/** Injected opts for tests. */
export interface RememberOpts {
  provider?: Provider;
  _provider?: MemoryProvider;
}

/**
 * Run the `astramem remember` subcommand.
 *
 * Parses --content, --type, --metadata from args.
 * Calls provider.remember(req).
 * Returns 0 on success, 3 on backend error.
 */
export async function runRemember(args: string[], opts: RememberOpts = {}): Promise<number> {
  // Parse args
  let content: string | undefined;
  let type = 'fact';
  let metadata: Record<string, unknown> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--content':
        content = args[i + 1];
        i++;
        break;
      case '--type':
        type = args[i + 1] ?? 'fact';
        i++;
        break;
      case '--metadata':
        try {
          metadata = JSON.parse(args[i + 1] ?? '{}') as Record<string, unknown>;
        } catch {
          process.stderr.write('astramem remember: --metadata must be valid JSON\n');
          return 3;
        }
        i++;
        break;
      default:
        break;
    }
  }

  if (!content) {
    process.stderr.write('astramem remember: --content <text> is required\n');
    return 3;
  }

  // Build payload — remember reuses IngestPayload shape
  const payloadParsed = IngestPayloadSchema.safeParse({
    id: `remember-${Date.now()}`,
    type,
    text: content,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  });
  if (!payloadParsed.success) {
    process.stderr.write(`astramem remember: invalid payload — ${payloadParsed.error.message}\n`);
    return 3;
  }
  const payload = payloadParsed.data;

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
    process.stderr.write(`astramem remember: selector error — ${(e as Error).message}\n`);
    return 3;
  }

  try {
    await provider.remember(payload);
    process.stdout.write('ok\n');
    return 0;
  } catch (e) {
    process.stderr.write(`astramem remember: backend error — ${(e as Error).message}\n`);
    return 3;
  }
}
