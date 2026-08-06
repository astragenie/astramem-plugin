/**
 * Demo AstraMemory provider — zero-daemon, zero-network trial mode.
 *
 * Backs `astramem connect --demo` (Wave 2 Track A, demo-readiness programme).
 * Unlike LocalProvider/SaasProvider this provider never opens a socket: it
 * never calls fetch() and never spawns a process. Memories live in a JSON
 * file under the unified config dir (demo-store.json), isolated from real
 * local/saas state (config.json, local.json, secrets.env) so demo data can
 * never be mistaken for — or contaminate — a real connection.
 *
 * Every `astramem` subcommand is a fresh CLI process, so "in-memory" here
 * means "no external daemon and no HTTP calls", not "process-lifetime
 * only" — the file is what lets `astramem recall` see what an earlier
 * `astramem remember` call (a separate process) wrote during the same demo
 * session. `connect --demo` reseeds this store with fresh canned memories
 * on every call (resetDemoStore()); plain `connect` wipes it entirely
 * (clearDemoStore()) — so demo data never survives past the demo session,
 * matching the "DEMO MODE — data is ephemeral" contract shown to the user.
 *
 * Scoring is a deterministic keyword-overlap heuristic (no model, no
 * network, no randomness) — good enough to make the canned sample recall
 * look sensible, not a real ranking algorithm. See scoreMatch().
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { MemoryProvider } from '../contracts/provider.ts';
import type {
  IngestPayload,
  RecallRequest,
  RecallResponse,
  RecallHit,
  HealthResponse,
  TranscriptIngestPayload,
} from '../contracts/wire.ts';
import { unifiedConfigDir } from '../lib/datadir.ts';

const DEMO_STORE_FILENAME = 'demo-store.json';
const DEMO_VERSION = 'demo-0.1.0';

/** A canonical sample question the seed memories are designed to answer
 * well — used by `connect --demo`'s post-connect recall preview and by
 * the provider's own tests. */
export const DEMO_SAMPLE_QUESTION = 'Is demo mode data sent over the network?';

interface DemoEntry {
  id: string;
  type: string;
  text: string;
  source?: string;
  importance?: number;
  confidence?: number;
}

function demoStorePath(): string {
  return join(unifiedConfigDir(), DEMO_STORE_FILENAME);
}

/**
 * Canned seed memories for a live demo — generic enough to read naturally
 * for any repo, personalized with the current project name (same
 * basename(cwd) convention SaasProvider.resolveProjectId() uses elsewhere
 * in this codebase). Deliberately varied types (decision/fact/lesson/
 * preference/todo) so a sample recall has something to discriminate
 * between, mirroring astramem-local's own `demo` command seed set.
 */
export function buildSeedMemories(projectName: string = basename(process.cwd())): DemoEntry[] {
  return [
    {
      id: 'demo-seed-1',
      type: 'decision',
      text:
        `Decision: astramem connect --demo pairs this workstation to an ephemeral demo provider for ` +
        `'${projectName}' — no astramem-local install and no SaaS claim code required.`,
      source: 'demo',
    },
    {
      id: 'demo-seed-2',
      type: 'fact',
      text:
        'Demo mode stores a handful of example memories entirely on this machine — nothing is sent ' +
        'over the network, and no external daemon process is started.',
      source: 'demo',
    },
    {
      id: 'demo-seed-3',
      type: 'lesson',
      text:
        'Lesson: run `astramem health` right after connecting to confirm the provider — demo, local, ' +
        'or saas — is actually reachable before trusting recall results.',
      source: 'demo',
    },
    {
      id: 'demo-seed-4',
      type: 'preference',
      text:
        `The user prefers a quick recall preview for '${projectName}' immediately after connecting, ` +
        'so they can see the memory loop working without extra commands.',
      source: 'demo',
    },
    {
      id: 'demo-seed-5',
      type: 'todo',
      text:
        'TODO: when ready for real persistence, run `astramem connect` (without --demo) to pair with a ' +
        'real local daemon or SaaS account — demo data is ephemeral and does not carry over.',
      source: 'demo',
    },
  ];
}

function readStore(): DemoEntry[] {
  try {
    const raw = readFileSync(demoStorePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DemoEntry[]) : [];
  } catch {
    // Missing or unreadable store — treat as empty rather than erroring;
    // demo mode must never block on a stray file-system issue.
    return [];
  }
}

function writeStore(entries: DemoEntry[]): void {
  const dir = unifiedConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(demoStorePath(), JSON.stringify(entries, null, 2) + '\n', 'utf-8');
}

/**
 * Reseed the demo store with fresh canned memories — called by
 * `connect --demo` on every invocation, so demo mode always starts from
 * the same known-good state (any earlier remembered items are dropped).
 */
export function resetDemoStore(projectName?: string): DemoEntry[] {
  const seed = buildSeedMemories(projectName);
  writeStore(seed);
  return seed;
}

/**
 * Wipe the demo store entirely — called by plain `connect` (no --demo) so
 * leaving demo mode never leaves stale demo data around to be recalled
 * after re-pairing with a real provider.
 */
export function clearDemoStore(): void {
  try {
    if (existsSync(demoStorePath())) unlinkSync(demoStorePath());
  } catch {
    // Best-effort — never block a real connect on demo cleanup.
  }
}

/** True when the demo store file exists (i.e. a demo session is active). */
export function isDemoStoreActive(): boolean {
  return existsSync(demoStorePath());
}

// ---------------------------------------------------------------------------
// Deterministic mock scoring — word-overlap heuristic, no model, no network,
// no randomness.
// ---------------------------------------------------------------------------

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Deterministic relevance score in [0,1]: the fraction of query words that
 * appear anywhere in the candidate text, plus a small bonus when the raw
 * query is a substring of the text. Good enough to make the canned sample
 * recall discriminate sensibly between seed memories — not a real ranking
 * algorithm, and never calls out to a model or the network.
 */
export function scoreMatch(query: string, text: string): number {
  const qWords = words(query);
  if (qWords.length === 0) return 0;
  const tWords = new Set(words(text));
  const hits = qWords.filter((w) => tWords.has(w)).length;
  let score = hits / qWords.length;
  if (text.toLowerCase().includes(query.toLowerCase())) {
    score = Math.min(1, score + 0.15);
  }
  return Math.min(1, Math.max(0, score));
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class DemoProvider implements MemoryProvider {
  /** Fire-and-forget, no-op — demo mode has no transcript pipeline. Never
   *  throws, per the MemoryProvider fire-and-forget contract. */
  async ingest(_payload: IngestPayload): Promise<void> {
    return;
  }

  /** Same as ingest() — no-op, never throws. */
  async ingestTranscript(_payload: TranscriptIngestPayload): Promise<void> {
    return;
  }

  async recall(req: RecallRequest): Promise<RecallResponse> {
    const store = readStore();
    const scored = store
      .map((entry) => ({ entry, score: scoreMatch(req.query, entry.text) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, req.k);
    const hits: RecallHit[] = scored.map(({ entry, score }) => ({
      id: entry.id,
      type: entry.type,
      text: entry.text,
      score,
      ...(entry.source !== undefined ? { source: entry.source } : {}),
      ...(entry.importance !== undefined ? { importance: entry.importance } : {}),
      ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
    }));
    return { hits, total_searched: store.length, provider: 'demo' };
  }

  async remember(req: IngestPayload): Promise<void> {
    const store = readStore();
    store.push({
      id: req.id,
      type: req.type,
      text: req.text,
      ...(req.source !== undefined ? { source: req.source } : {}),
      ...(req.importance !== undefined ? { importance: req.importance } : {}),
      ...(req.confidence !== undefined ? { confidence: req.confidence } : {}),
    });
    writeStore(store);
  }

  /**
   * Self-healing: if the store is missing (e.g. `--provider demo health`
   * without a prior `connect --demo`), seed it on the fly rather than
   * reporting unhealthy — demo mode should never require a specific
   * command order to look alive.
   */
  async health(): Promise<HealthResponse> {
    if (!isDemoStoreActive()) resetDemoStore();
    return { ok: true, version: DEMO_VERSION, url: 'demo://in-memory', latencyMs: 0 };
  }
}
