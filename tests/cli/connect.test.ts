/**
 * Tests for src/cli/connect.ts — astramem connect subcommand.
 *
 * Uses a real HTTP server (createServer) to mock the daemon's /health endpoint.
 * The daemon has never had a /register route, so runConnect() probes /health directly.
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

  it('returns 0 when /health succeeds', async () => {
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

  it('hits /health directly (no /register attempt)', async () => {
    let registerHit = false;
    const srv = await makeServer((req, res) => {
      if (req.url === '/register') {
        registerHit = true;
        res.writeHead(200);
        res.end();
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
      expect(registerHit).toBe(false);
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

  it('returns 3 when /health fails', async () => {
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
