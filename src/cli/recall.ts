// astramem recall — recall memories matching a query.
// Resolves provider, calls provider.recall(), prints normalized JSON to stdout.
// Exit 0 on success, exit 3 on backend error.
import { RecallRequestSchema } from '../contracts/wire.ts';
import type { Provider } from '../contracts/selector.ts';
import type { MemoryProvider } from '../contracts/provider.ts';
import { resolveProvider } from '../lib/selector.ts';

/** Injected opts for tests. */
export interface RecallOpts {
  provider?: Provider;
  _provider?: MemoryProvider;
}

/**
 * Run the `astramem recall` subcommand.
 *
 * Parses --query, --k, --repo, --project from args.
 * Calls provider.recall(req) with a 5s timeout.
 * Prints normalized RecallResponse JSON to stdout.
 * Returns 0 on success, 3 on backend error.
 */
export async function runRecall(args: string[], opts: RecallOpts = {}): Promise<number> {
  // Parse args
  let query: string | undefined;
  let k = 5;
  let repo: string | undefined;
  let project: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--query':
        query = args[i + 1];
        i++;
        break;
      case '--k':
        k = parseInt(args[i + 1] ?? '5', 10);
        i++;
        break;
      case '--repo':
        repo = args[i + 1];
        i++;
        break;
      case '--project':
        project = args[i + 1];
        i++;
        break;
      default:
        break;
    }
  }

  if (!query) {
    process.stderr.write('astramem recall: --query <text> is required\n');
    return 3;
  }

  const reqParsed = RecallRequestSchema.safeParse({ query, k, repo, project });
  if (!reqParsed.success) {
    process.stderr.write(`astramem recall: invalid arguments — ${reqParsed.error.message}\n`);
    return 3;
  }
  const req = reqParsed.data;

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
    process.stderr.write(`astramem recall: selector error — ${(e as Error).message}\n`);
    return 3;
  }

  // Call with 5s timeout
  try {
    let timedOut = false;
    const timeoutHandle = setTimeout(() => { timedOut = true; }, 5000);
    const response = await Promise.race([
      provider.recall(req),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('recall timed out after 5s')), 5000)),
    ]);
    clearTimeout(timeoutHandle);
    if (timedOut) {
      process.stderr.write('astramem recall: timed out\n');
      return 3;
    }
    process.stdout.write(JSON.stringify(response, null, 2) + '\n');
    return 0;
  } catch (e) {
    process.stderr.write(`astramem recall: backend error — ${(e as Error).message}\n`);
    return 3;
  }
}
