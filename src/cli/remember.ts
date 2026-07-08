// astramem remember — store a new memory item.
// Resolves provider, calls provider.remember(req).
// Exit 0 on success, exit 3 on backend error.
import { IngestPayloadSchema } from '../contracts/wire.ts';
import type { Provider } from '../contracts/selector.ts';
import type { MemoryProvider } from '../contracts/provider.ts';
import { resolveProvider } from '../lib/selector.ts';
import { resolveProject } from '../lib/project.ts';

/** Injected opts for tests. */
export interface RememberOpts {
  provider?: Provider;
  _provider?: MemoryProvider;
}

/**
 * Run the `astramem remember` subcommand.
 *
 * Parses --content, --type, --metadata, --project, --agent from args
 * (--project/--agent fold into metadata for daemon persistence).
 * Calls provider.remember(req).
 * Returns 0 on success, 3 on backend error.
 */
export async function runRemember(args: string[], opts: RememberOpts = {}): Promise<number> {
  // Parse args
  let content: string | undefined;
  let type = 'fact';
  let metadata: Record<string, unknown> = {};
  let project: string | undefined;
  let agent: string | undefined;
  let cwd: string | undefined;

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
      case '--project':
        project = args[i + 1];
        i++;
        break;
      case '--agent':
        agent = args[i + 1];
        i++;
        break;
      case '--cwd':
        cwd = args[i + 1];
        i++;
        break;
      default:
        break;
    }
  }

  // issue #33: resolveProject() is the single source of truth for the
  // default project scope — flag > ASTRAMEM_PROJECT env > config.project >
  // basename(cwd). Always resolves to a non-empty string.
  const resolvedProject = resolveProject({ flag: project, cwd });

  // FEAT-423: convenience flags fold into metadata (daemon reads
  // metadata.project / metadata.agent → persists on the atom). Explicit
  // --metadata JSON keys win if both are supplied.
  if (metadata['project'] === undefined) metadata['project'] = resolvedProject;
  if (agent !== undefined && metadata['agent'] === undefined) metadata['agent'] = agent;

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
    // A single remember() call always saves exactly one atom of the parsed
    // type — structured so callers (and the remember-marker hook shim,
    // issue #40) can format an inline save marker without re-deriving the
    // count. See src/lib/save-marker.ts.
    const result = { ok: true, saved: 1, by_type: { [payload.type]: 1 } };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`astramem remember: backend error — ${(e as Error).message}\n`);
    return 3;
  }
}
