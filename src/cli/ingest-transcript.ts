// astramem ingest-transcript — fire-and-forget transcript ingest subcommand.
// FEAT 4a §4.1.1: reads a JSONL transcript file, filters/tails/truncates,
// applies scrub per turn, builds a TranscriptIngestPayload envelope, POSTs
// via LocalProvider.ingestTranscript(). Always exits 0 (fire-and-forget contract).
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscriptIngestPayloadSchema } from '../contracts/wire.ts';
import type { TranscriptIngestPayload, TranscriptTurn } from '../contracts/wire.ts';
import { scrub, BEARER_RE } from '../lib/scrub.ts';
import { appendIngestLog } from '../lib/log.ts';
import { resolveProvider } from '../lib/selector.ts';
import type { Provider } from '../contracts/selector.ts';

// ---------------------------------------------------------------------------
// Minimal interface for the provider used by this subcommand.
// LocalProvider implements this; tests inject a mock.
// ---------------------------------------------------------------------------

export interface TranscriptProvider {
  ingestTranscript(payload: TranscriptIngestPayload): Promise<void>;
}

export interface IngestTranscriptOpts {
  /** Provider override from --provider flag. */
  provider?: Provider;
  /** Injected provider (tests only — bypasses selector). */
  _provider?: TranscriptProvider;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  event: string | undefined;
  transcriptPath: string | undefined;
  sessionId: string | undefined;
  projectId: string | undefined;
  agentType: string | undefined;
  cwd: string | undefined;
  maxTurns: number;
  maxChars: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  let event: string | undefined;
  let transcriptPath: string | undefined;
  let sessionId: string | undefined;
  let projectId: string | undefined;
  let agentType: string | undefined;
  let cwd: string | undefined;
  let maxTurns = 20;
  let maxChars = 12000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    switch (arg) {
      case '--event':
        event = next;
        i++;
        break;
      case '--transcript-path':
        transcriptPath = next;
        i++;
        break;
      case '--session-id':
        sessionId = next;
        i++;
        break;
      case '--project-id':
        projectId = next;
        i++;
        break;
      case '--agent-type':
        agentType = next;
        i++;
        break;
      case '--cwd':
        cwd = next;
        i++;
        break;
      case '--max-turns': {
        const n = parseInt(next ?? '', 10);
        if (!isNaN(n) && n > 0) maxTurns = n;
        i++;
        break;
      }
      case '--max-chars': {
        const n = parseInt(next ?? '', 10);
        if (!isNaN(n) && n > 0) maxChars = n;
        i++;
        break;
      }
    }
  }

  return { event, transcriptPath, sessionId, projectId, agentType, cwd, maxTurns, maxChars };
}

// ---------------------------------------------------------------------------
// Read plugin version from plugin.json at runtime
// ---------------------------------------------------------------------------

function readClientVersion(): string {
  try {
    // Resolve relative to this file: src/cli/ → ../../.claude-plugin/plugin.json
    const thisFile = fileURLToPath(import.meta.url);
    const pluginJsonPath = join(dirname(thisFile), '..', '..', '.claude-plugin', 'plugin.json');
    const raw = readFileSync(pluginJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Transcript processing
// ---------------------------------------------------------------------------

interface RawLine {
  role?: unknown;
  content?: unknown;
  text?: unknown;
  timestamp?: unknown;
}

function extractTurnsFromJsonl(raw: string): Array<{ role: string; text: string; ts?: string }> {
  const turns: Array<{ role: string; text: string; ts?: string }> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: RawLine;
    try {
      parsed = JSON.parse(trimmed) as RawLine;
    } catch {
      continue; // skip malformed lines
    }

    const role = parsed.role;
    if (role !== 'user' && role !== 'assistant') continue;

    // Extract text: prefer 'text', fall back to 'content' (Claude hook payloads may use either)
    let text = '';
    if (typeof parsed.text === 'string') {
      text = parsed.text;
    } else if (typeof parsed.content === 'string') {
      text = parsed.content;
    } else if (Array.isArray(parsed.content)) {
      // Content blocks: extract text from {type:'text', text:'...'} entries
      for (const block of parsed.content as Array<unknown>) {
        if (
          block !== null &&
          typeof block === 'object' &&
          (block as Record<string, unknown>)['type'] === 'text' &&
          typeof (block as Record<string, unknown>)['text'] === 'string'
        ) {
          text += (block as Record<string, unknown>)['text'] as string;
        }
      }
    }

    if (!text) continue;

    const ts = typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined;
    turns.push({ role, text, ...(ts !== undefined ? { ts } : {}) });
  }
  return turns;
}

/**
 * Truncate turns to fit within maxChars total, dropping oldest first.
 * Returns the remaining turns (tail of the array after dropping).
 */
function truncateToMaxChars(
  turns: Array<{ role: string; text: string; ts?: string }>,
  maxChars: number,
): Array<{ role: string; text: string; ts?: string }> {
  let total = turns.reduce((acc, t) => acc + t.text.length, 0);
  let start = 0;
  while (total > maxChars && start < turns.length) {
    total -= turns[start]!.text.length;
    start++;
  }
  return turns.slice(start);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the `astramem ingest-transcript` subcommand.
 *
 * Fire-and-forget contract: always returns 0.
 * Exit code 3 only for missing required flag --event (not fire-and-forget — an
 * invalid invocation without a discriminator is a programming error in the caller).
 */
export async function runIngestTranscript(
  argv: string[],
  opts: IngestTranscriptOpts = {},
): Promise<number> {
  const args = parseArgs(argv);

  // --event is required — discriminator; exit 3 to surface misconfigured hook shim.
  if (!args.event) {
    process.stderr.write('astramem ingest-transcript: --event <pre_compact|session_end|subagent_stop> is required\n');
    return 3;
  }

  // --transcript-path missing → silent exit 0 (hook contract: not-found is not an error)
  if (!args.transcriptPath) {
    appendIngestLog('ingest-transcript: --transcript-path not provided; skipping');
    return 0;
  }

  // --session-id and --project-id are required for a meaningful envelope.
  // But per fire-and-forget: log and exit 0 rather than hard-fail.
  if (!args.sessionId || !args.projectId) {
    appendIngestLog('ingest-transcript: --session-id and --project-id are required; skipping');
    return 0;
  }

  // Read transcript file — file-not-found → silent exit 0 (fire-and-forget)
  let raw: string;
  try {
    if (!existsSync(args.transcriptPath)) {
      appendIngestLog(`ingest-transcript: transcript file not found: ${args.transcriptPath}`);
      return 0;
    }
    raw = readFileSync(args.transcriptPath, 'utf-8');
  } catch (e) {
    appendIngestLog(`ingest-transcript: failed to read transcript: ${(e as Error).message}`);
    return 0;
  }

  // Parse JSONL, filter to user/assistant roles, tail to maxTurns
  const allTurns = extractTurnsFromJsonl(raw);
  const tailed = allTurns.slice(-args.maxTurns);

  // Truncate oldest-first to fit maxChars
  const truncated = truncateToMaxChars(tailed, args.maxChars);

  // Apply scrub per turn text via src/lib/scrub.ts (single source of truth —
  // §5.3 scrub-parity gate compares this against bash _ingest-transcript.sh).
  // Hit count uses the same exported BEARER_RE so it cannot drift.
  let totalScrubHits = 0;
  const scrubbedTurns: TranscriptTurn[] = truncated.map((t) => {
    const matches = t.text.match(BEARER_RE);
    totalScrubHits += matches?.length ?? 0;
    const scrubbedText = scrub(t.text) as string;
    const turn: TranscriptTurn = {
      role: t.role as 'user' | 'assistant',
      text: scrubbedText,
    };
    if (t.ts !== undefined) turn.ts = t.ts;
    return turn;
  });

  // Read client version from plugin.json
  const clientVersion = readClientVersion();

  // Build envelope
  const envelope: TranscriptIngestPayload = {
    event: args.event as 'pre_compact' | 'session_end' | 'subagent_stop',
    session_id: args.sessionId,
    project_id: args.projectId,
    captured_at: new Date().toISOString(),
    turns: scrubbedTurns,
    client_scrub_applied: true,
    client_scrub_hits: totalScrubHits,
    client_version: clientVersion,
    ...(args.agentType !== undefined ? { agent_type: args.agentType } : {}),
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
  };

  // Validate envelope shape (defensive — should always pass given we constructed it)
  const validation = TranscriptIngestPayloadSchema.safeParse(envelope);
  if (!validation.success) {
    const issues = validation.error.issues.map((i) => i.message).join(', ');
    appendIngestLog(`ingest-transcript: envelope validation failed — ${issues}`);
    return 0;
  }

  // Resolve provider (Option B: sibling method ingestTranscript)
  let provider: TranscriptProvider;
  try {
    if (opts._provider) {
      provider = opts._provider;
    } else {
      const sel = await resolveProvider({ flag: opts.provider });
      // LocalProvider has ingestTranscript; cast safely
      provider = sel.provider as unknown as TranscriptProvider;
    }
  } catch (e) {
    appendIngestLog(`ingest-transcript: selector error — ${(e as Error).message}`);
    return 0;
  }

  // Fire-and-forget: race the call against 2s timeout
  try {
    const call = provider.ingestTranscript(validation.data);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000));
    await Promise.race([call, timeout]);
  } catch (e) {
    appendIngestLog(`ingest-transcript: provider error — ${(e as Error).message}`);
    // Intentionally swallow — fire-and-forget
  }

  return 0;
}
