/**
 * Tests for src/cli/agent-profile.ts — astramem agent-profile subcommand.
 *
 * Local-daemon-only (see file header) — no MemoryProvider selector involved.
 * Uses a real HTTP server (createServer), same convention as connect.test.ts,
 * with APPDATA redirected to an empty tmp dir so no real secrets.env leaks in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentProfile } from '../../src/cli/agent-profile.ts';

interface TestServer {
  url: string;
  lastReq: { method?: string; url?: string; headers: Record<string, string | string[] | undefined> } | null;
  close: () => Promise<void>;
}

function makeServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestServer> {
  return new Promise((resolve) => {
    let lastReq: TestServer['lastReq'] = null;
    const srv = createServer((req, res) => {
      lastReq = { method: req.method, url: req.url, headers: req.headers };
      handler(req, res);
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as import('node:net').AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        get lastReq() { return lastReq; },
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { stdout.push(String(c)); return true; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { stderr.push(String(c)); return true; });
  return {
    stdout,
    stderr,
    restore: () => { outSpy.mockRestore(); errSpy.mockRestore(); },
    json: () => JSON.parse(stdout.join('')),
  };
}

const SAMPLE_PROFILE = {
  agent: 'crew:builder',
  counts: { lesson: 2 },
  total: 2,
  first_seen: 100,
  last_active: 200,
  top_lessons: [
    { id: 'l1', text: 'Always run tests before shipping.', importance: 0.9, usefulness: 0.8, created_at: 100 },
  ],
  recent_decisions: [],
  corrections: [],
};

describe('runAgentProfile', () => {
  let cap: ReturnType<typeof captureOutput>;
  let tmpDir: string;
  let origAppdata: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'astramem-agent-profile-test-'));
    origAppdata = process.env['APPDATA'];
    process.env['APPDATA'] = tmpDir;
    // Isolate from whatever real bearer this dev/CI machine has configured —
    // readLocalBearer() falls back to these env vars when secrets.env (under
    // the now-redirected APPDATA) doesn't have one.
    vi.stubEnv('MEMORY_BEARER', '');
    vi.stubEnv('ASTRAMEMORY_API_KEY', '');
    cap = captureOutput();
  });

  afterEach(() => {
    cap.restore();
    vi.unstubAllEnvs();
    if (origAppdata === undefined) delete process.env['APPDATA'];
    else process.env['APPDATA'] = origAppdata;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 3 and writes nothing when --agent is missing', async () => {
    const code = await runAgentProfile([]);
    expect(code).toBe(3);
    expect(cap.stdout.join('')).toBe('');
  });

  it('returns 0 and prints AgentProfile JSON on 200', async () => {
    const srv = await makeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SAMPLE_PROFILE));
    });
    try {
      const code = await runAgentProfile(['--agent', 'crew:builder'], { _baseUrl: srv.url });
      expect(code).toBe(0);
      const out = cap.json();
      expect(out).toMatchObject({ agent: 'crew:builder', total: 2 });
      expect(out.top_lessons[0].text).toBe('Always run tests before shipping.');
      // URL is agent-scoped and percent-encoded.
      expect(srv.lastReq?.method).toBe('GET');
      expect(srv.lastReq?.url).toBe('/agents/crew%3Abuilder/profile');
      // No secrets.env / MEMORY_BEARER configured in the isolated APPDATA → no header.
      expect(srv.lastReq?.headers['authorization']).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it('returns 3 and writes nothing to stdout on 404 (agent has zero memories)', async () => {
    const srv = await makeServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', agent: 'nobody' }));
    });
    try {
      const code = await runAgentProfile(['--agent', 'nobody'], { _baseUrl: srv.url });
      expect(code).toBe(3);
      expect(cap.stdout.join('')).toBe('');
    } finally {
      await srv.close();
    }
  });

  it('returns 3 and writes nothing to stdout when the daemon is unreachable', async () => {
    // 127.0.0.1:1 — nothing listens there; connection refused fast.
    const code = await runAgentProfile(['--agent', 'crew:builder'], { _baseUrl: 'http://127.0.0.1:1' });
    expect(code).toBe(3);
    expect(cap.stdout.join('')).toBe('');
  });

  it('returns 3 and writes nothing to stdout when the response fails schema validation', async () => {
    const srv = await makeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ not: 'a valid profile' }));
    });
    try {
      const code = await runAgentProfile(['--agent', 'crew:builder'], { _baseUrl: srv.url });
      expect(code).toBe(3);
      expect(cap.stdout.join('')).toBe('');
    } finally {
      await srv.close();
    }
  });

  it('sends the Authorization header when a bearer is configured', async () => {
    vi.stubEnv('MEMORY_BEARER', 'test-bearer-token');
    const srv = await makeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SAMPLE_PROFILE));
    });
    try {
      await runAgentProfile(['--agent', 'crew:builder'], { _baseUrl: srv.url });
      expect(srv.lastReq?.headers['authorization']).toBe('Bearer test-bearer-token');
    } finally {
      await srv.close();
      vi.unstubAllEnvs();
    }
  });
});
