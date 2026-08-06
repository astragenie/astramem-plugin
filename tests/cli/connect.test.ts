/**
 * Tests for src/cli/connect.ts — astramem connect subcommand.
 *
 * Uses a real HTTP server (createServer) to mock the daemon endpoints.
 * Also tests fallback to /health when /register returns 404.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConnect } from '../../src/cli/connect.ts';

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

function makeServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as import('node:net').AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
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
    text: () => stdout.join(''),
  };
}

describe('runConnect', () => {
  let cap: ReturnType<typeof captureOutput>;
  let tmpDir: string;
  let origAppdata: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'astramem-connect-test-'));
    origAppdata = process.env['APPDATA'];
    process.env['APPDATA'] = tmpDir;
    cap = captureOutput();
  });

  afterEach(async () => {
    cap.restore();
    if (origAppdata === undefined) delete process.env['APPDATA'];
    else process.env['APPDATA'] = origAppdata;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 0 when /register succeeds', async () => {
    const srv = await makeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.2.0', ok: true }));
    });

    // Override config to point to test server
    const { setValue } = await import('../../src/lib/config.ts');
    setValue('local.url', srv.url);

    try {
      const code = await runConnect();
      expect(code).toBe(0);
      expect(cap.text()).toMatch(/CONNECTED/);
    } finally {
      await srv.close();
    }
  });

  it('returns 0 and falls back to /health when /register returns 404', async () => {
    const srv = await makeServer((req, res) => {
      if (req.url === '/register') {
        res.writeHead(404);
        res.end('not found');
      } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: '0.1.0' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const { setValue } = await import('../../src/lib/config.ts');
    setValue('local.url', srv.url);

    try {
      const code = await runConnect();
      expect(code).toBe(0);
      expect(cap.text()).toMatch(/CONNECTED/);
    } finally {
      await srv.close();
    }
  });

  it('returns 3 when daemon is unreachable', async () => {
    // Use a port that's not listening
    const { setValue } = await import('../../src/lib/config.ts');
    setValue('local.url', 'http://127.0.0.1:19999');

    const code = await runConnect();
    expect(code).toBe(3);
    expect(cap.text()).toMatch(/FAILED/);
  });

  it('caches result in local.json', async () => {
    const srv = await makeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.2.0', ok: true }));
    });

    const { setValue } = await import('../../src/lib/config.ts');
    setValue('local.url', srv.url);

    try {
      await runConnect();
      // Check local.json was created
      const { readFileSync, existsSync } = await import('node:fs');
      const { unifiedConfigDir } = await import('../../src/lib/datadir.ts');
      const localJson = join(unifiedConfigDir(), 'local.json');
      expect(existsSync(localJson)).toBe(true);
      const cached = JSON.parse(readFileSync(localJson, 'utf-8')) as Record<string, unknown>;
      expect(cached).toHaveProperty('ok', true);
      expect(cached).toHaveProperty('registered_at');
    } finally {
      await srv.close();
    }
  });

  it('returns 3 when /register returns 404 and /health also fails', async () => {
    const srv = await makeServer((_req, res) => {
      res.writeHead(404);
      res.end('not found');
    });

    const { setValue } = await import('../../src/lib/config.ts');
    setValue('local.url', srv.url);

    try {
      const code = await runConnect();
      expect(code).toBe(3);
    } finally {
      await srv.close();
    }
  });
});

describe('runConnect --demo', () => {
  let cap: ReturnType<typeof captureOutput>;
  let tmpDir: string;
  let origAppdata: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'astramem-connect-demo-test-'));
    origAppdata = process.env['APPDATA'];
    process.env['APPDATA'] = tmpDir;
    cap = captureOutput();
  });

  afterEach(async () => {
    cap.restore();
    if (origAppdata === undefined) delete process.env['APPDATA'];
    else process.env['APPDATA'] = origAppdata;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('activates demo mode: exits 0, prints a DEMO MODE banner, sets config.provider to demo', async () => {
    const code = await runConnect(['--demo']);
    expect(code).toBe(0);
    const text = cap.text();
    expect(text).toMatch(/DEMO MODE/);
    expect(text).toMatch(/ephemeral/i);

    const { loadConfig } = await import('../../src/lib/config.ts');
    expect(loadConfig().provider).toBe('demo');
  });

  it('seeds the demo store so a subsequent health probe reports ok', async () => {
    await runConnect(['--demo']);
    const { DemoProvider, isDemoStoreActive } = await import('../../src/providers/demo.ts');
    expect(isDemoStoreActive()).toBe(true);
    const health = await new DemoProvider().health();
    expect(health.ok).toBe(true);
  });

  it('caches a demo result in local.json, clearly marked demo:true', async () => {
    await runConnect(['--demo']);
    const { readFileSync } = await import('node:fs');
    const { unifiedConfigDir } = await import('../../src/lib/datadir.ts');
    const cached = JSON.parse(
      readFileSync(join(unifiedConfigDir(), 'local.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(cached['ok']).toBe(true);
    expect(cached['demo']).toBe(true);
  });

  it('never makes a network call — an unreachable local.url does not affect --demo', async () => {
    const { setValue } = await import('../../src/lib/config.ts');
    setValue('local.url', 'http://127.0.0.1:19999'); // nothing listening
    const code = await runConnect(['--demo']);
    expect(code).toBe(0);
    expect(cap.text()).toMatch(/DEMO MODE/);
  });

  it('running --demo twice reseeds cleanly (idempotent, drops prior demo-session data)', async () => {
    await runConnect(['--demo']);
    const { DemoProvider } = await import('../../src/providers/demo.ts');
    await new DemoProvider().remember({
      id: 'extra-1',
      type: 'note',
      text: 'a memory added during the first demo session',
    });

    const code = await runConnect(['--demo']);
    expect(code).toBe(0);

    const res = await new DemoProvider().recall({ query: 'extra-1 first demo session', k: 10 });
    expect(res.hits.some((h) => h.id === 'extra-1')).toBe(false); // reseeded away
  });

  it('plain connect (no --demo) exits demo mode: resets provider off demo and clears the demo store', async () => {
    await runConnect(['--demo']);
    const { loadConfig } = await import('../../src/lib/config.ts');
    expect(loadConfig().provider).toBe('demo');

    const srv = await makeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.2.0', ok: true }));
    });
    const { setValue } = await import('../../src/lib/config.ts');
    setValue('local.url', srv.url);

    try {
      const code = await runConnect([]);
      expect(code).toBe(0);
      expect(loadConfig().provider).not.toBe('demo');
      const { isDemoStoreActive } = await import('../../src/providers/demo.ts');
      expect(isDemoStoreActive()).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it('plain connect when never in demo mode behaves exactly as before (no regression)', async () => {
    const srv = await makeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.2.0', ok: true }));
    });
    const { setValue } = await import('../../src/lib/config.ts');
    setValue('local.url', srv.url);

    try {
      const code = await runConnect([]);
      expect(code).toBe(0);
      expect(cap.text()).toMatch(/CONNECTED/);
    } finally {
      await srv.close();
    }
  });
});
