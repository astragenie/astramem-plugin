/**
 * Cross-call-site project-scope consistency test (issue #33).
 *
 * The point of resolveProject() is that remember / recall / ingest-transcript
 * derive the SAME default project for a given cwd + env + flag combination,
 * instead of each call site inventing its own (or no) derivation. This test
 * drives all three subcommands with an identical cwd/env/flag combo and
 * asserts they land on the same resolved project string.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRemember } from '../../src/cli/remember.ts';
import { runRecall } from '../../src/cli/recall.ts';
import { runIngestTranscript } from '../../src/cli/ingest-transcript.ts';
import { createMockProvider } from './mock-provider.ts';
import type { TranscriptIngestPayload } from '../../src/contracts/wire.ts';

let tmpDir: string;
let transcriptDir: string;
let originalAppData: string | undefined;
let originalHome: string | undefined;
let originalEnvProject: string | undefined;

function isolateEnv(): void {
  tmpDir = mkdtempSync(join(tmpdir(), 'astramem-consistency-'));
  transcriptDir = mkdtempSync(join(tmpdir(), 'astramem-consistency-transcript-'));
  originalAppData = process.env['APPDATA'];
  originalHome = process.env['HOME'];
  originalEnvProject = process.env['ASTRAMEM_PROJECT'];
  process.env['APPDATA'] = tmpDir;
  if (process.platform !== 'win32') {
    process.env['HOME'] = tmpDir;
  }
  delete process.env['ASTRAMEM_PROJECT'];
}

function restoreEnv(): void {
  if (originalAppData !== undefined) process.env['APPDATA'] = originalAppData;
  else delete process.env['APPDATA'];
  if (process.platform !== 'win32') {
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
    else delete process.env['HOME'];
  }
  if (originalEnvProject !== undefined) process.env['ASTRAMEM_PROJECT'] = originalEnvProject;
  else delete process.env['ASTRAMEM_PROJECT'];
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  if (transcriptDir && existsSync(transcriptDir)) rmSync(transcriptDir, { recursive: true, force: true });
}

function writeTranscript(): string {
  const filePath = join(transcriptDir, 'transcript.jsonl');
  writeFileSync(filePath, JSON.stringify({ role: 'user', text: 'hi' }), 'utf-8');
  return filePath;
}

function captureOutput() {
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return { restore: () => { outSpy.mockRestore(); } };
}

describe('resolveProject cross-call-site consistency (issue #33)', () => {
  let cap: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    isolateEnv();
    cap = captureOutput();
  });
  afterEach(() => {
    cap.restore();
    restoreEnv();
  });

  it('remember / recall / ingest-transcript resolve to the same default project for one cwd (basename tier)', async () => {
    const cwd = '/home/user/projects/consistency-app';
    const expectedProject = 'consistency-app';

    const rememberProvider = createMockProvider();
    await runRemember(['--content', 'note', '--cwd', cwd], { _provider: rememberProvider });
    const rememberArg = rememberProvider._stubs.remember.mock.calls[0]![0];
    expect((rememberArg.metadata as Record<string, unknown>).project).toBe(expectedProject);

    const recallProvider = createMockProvider();
    await runRecall(['--query', 'q', '--cwd', cwd], { _provider: recallProvider });
    expect(recallProvider._stubs.recall.mock.calls[0]![0]).toMatchObject({ project: expectedProject });

    const ingestProvider = createMockProvider();
    const transcriptPath = writeTranscript();
    await runIngestTranscript(
      ['--event', 'pre_compact', '--transcript-path', transcriptPath, '--session-id', 'sid', '--cwd', cwd],
      { _provider: ingestProvider },
    );
    const envelope = ingestProvider._stubs.ingestTranscript.mock.calls[0]![0] as TranscriptIngestPayload;
    expect(envelope.project_id).toBe(expectedProject);
  });

  it('remember / recall / ingest-transcript all defer to ASTRAMEM_PROJECT over basename(cwd)', async () => {
    process.env['ASTRAMEM_PROJECT'] = 'env-consistency-project';
    const cwd = '/home/user/projects/consistency-app';

    const rememberProvider = createMockProvider();
    await runRemember(['--content', 'note', '--cwd', cwd], { _provider: rememberProvider });
    const rememberArg = rememberProvider._stubs.remember.mock.calls[0]![0];
    expect((rememberArg.metadata as Record<string, unknown>).project).toBe('env-consistency-project');

    const recallProvider = createMockProvider();
    await runRecall(['--query', 'q', '--cwd', cwd], { _provider: recallProvider });
    expect(recallProvider._stubs.recall.mock.calls[0]![0]).toMatchObject({ project: 'env-consistency-project' });

    const ingestProvider = createMockProvider();
    const transcriptPath = writeTranscript();
    await runIngestTranscript(
      ['--event', 'pre_compact', '--transcript-path', transcriptPath, '--session-id', 'sid', '--cwd', cwd],
      { _provider: ingestProvider },
    );
    const envelope = ingestProvider._stubs.ingestTranscript.mock.calls[0]![0] as TranscriptIngestPayload;
    expect(envelope.project_id).toBe('env-consistency-project');
  });
});
