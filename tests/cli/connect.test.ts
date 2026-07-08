/**
 * Tests for src/cli/connect.ts — astramem connect subcommand.
 *
 * Uses a real HTTP server (createServer) to mock the daemon. connect probes
 * GET /health (reachability) then GET /whoami (bearer verification, added in
 * astramem-local#129). The daemon has never had a /register route, so connect
 * never probes one.
 *
 * Bearer presence is controlled per-test via writeBearer()/no-bearer — the
 * ambient MEMORY_BEARER / ASTRAMEMORY_API_KEY env is cleared in beforeEach so
 * the default is deterministically "no bearer".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConnect } from '../../src/cli/connect.ts';
import { unifiedConfigDir } from '../../src/lib/datadir.ts';

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

/** Route responses per path. Any unlisted path → 404. */
interface DaemonRoutes {
  health?: (res: ServerResponse) => void;
  whoami?: (res: ServerResponse) => void;
  onRegister?: () => void;
}

function makeDaemon(routes: DaemonRoutes): Promise<TestServer> {
  return makeServer((req, res) => {
    if (req.url === '/register') {
      routes.onRegister?.();
      res.writeHead(200);
      res.end();
    } else if (req.url === '/health' && routes.health) {
      routes.health(res);
    } else if (req.url === '/whoami' && routes.whoami) {
      routes.whoami(res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
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
  let origBearer: string | undefined;
  let origApiKey: string | undefined;

  /** Force a configured bearer by writing secrets.env into the config dir. */
  function writeBearer(token: string): void {
    const dir = unifiedConfigDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'secrets.env'), `MEMORY_BEARER=${token}\n`, 'utf-8');
  }

  function readCache(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(unifiedConfigDir(), 'local.json'), 'utf-8')) as Record<string, unknown>;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'astramem-connect-test-'));
    origAppdata = process.env['APPDATA'];
    process.env['APPDATA'] = tmpDir;
    // Deterministic "no bearer" default — clear ambient credentials.
    origBearer = process.env['MEMORY_BEARER'];
    origApiKey = process.env['ASTRAMEMORY_API_KEY'];
    delete process.env['MEMORY_BEARER'];
    delete process.env['ASTRAMEMORY_API_KEY'];
    cap = captureOutput();
  });

  afterEach(async () => {
    cap.restore();
    if (origAppdata === undefined) delete process.env['APPDATA'];
    else process.env['APPDATA'] = origAppdata;
    if (origBearer === undefined) delete process.env['MEMORY_BEARER'];
    else process.env['MEMORY_BEARER'] = origBearer;
    if (origApiKey === undefined) delete process.env['ASTRAMEMORY_API_KEY'];
    else process.env['ASTRAMEMORY_API_KEY'] = origApiKey;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function pointAt(url: string): Promise<void> {
    const { setValue } = await import('../../src/lib/config.ts');
    setValue('local.url', url);
  }

  it('returns 0 when /health succeeds', async () => {
    const srv = await makeDaemon({ health: (res) => json(res, 200, { version: '0.2.0', ok: true }) });
    await pointAt(srv.url);
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
    const srv = await makeDaemon({
      onRegister: () => { registerHit = true; },
      health: (res) => json(res, 200, { ok: true, version: '0.1.0' }),
    });
    await pointAt(srv.url);
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
    await pointAt('http://127.0.0.1:19999');
    const code = await runConnect();
    expect(code).toBe(3);
    expect(cap.text()).toMatch(/FAILED/);
  });

  it('caches result in local.json', async () => {
    const srv = await makeDaemon({ health: (res) => json(res, 200, { version: '0.2.0', ok: true }) });
    await pointAt(srv.url);
    try {
      await runConnect();
      const cached = readCache();
      expect(cached).toHaveProperty('ok', true);
      expect(cached).toHaveProperty('registered_at');
    } finally {
      await srv.close();
    }
  });

  it('returns 3 when /health fails', async () => {
    const srv = await makeDaemon({ health: (res) => { res.writeHead(404); res.end('not found'); } });
    await pointAt(srv.url);
    try {
      const code = await runConnect();
      expect(code).toBe(3);
    } finally {
      await srv.close();
    }
  });

  it('reports bearer_status "absent" and exit 0 when no bearer is configured', async () => {
    const srv = await makeDaemon({
      health: (res) => json(res, 200, { ok: true, version: '0.2.0' }),
      whoami: (res) => json(res, 200, { authenticated: true, version: '0.2.0' }), // should NOT be hit
    });
    await pointAt(srv.url);
    try {
      const code = await runConnect();
      expect(code).toBe(0);
      expect(readCache()['bearer_status']).toBe('absent');
      expect(readCache()).not.toHaveProperty('bearer_valid');
    } finally {
      await srv.close();
    }
  });

  it('reports bearer_status "verified" when /whoami accepts the bearer', async () => {
    writeBearer('good-token');
    const srv = await makeDaemon({
      health: (res) => json(res, 200, { ok: true, version: '0.9.0' }),
      whoami: (res) => json(res, 200, { authenticated: true, service: 'astramemory-local', version: '0.9.0' }),
    });
    await pointAt(srv.url);
    try {
      const code = await runConnect();
      expect(code).toBe(0);
      expect(readCache()['bearer_status']).toBe('verified');
      expect(readCache()['daemon_version']).toBe('0.9.0');
      expect(cap.text()).toMatch(/verified/);
    } finally {
      await srv.close();
    }
  });

  it('reports bearer_status "rejected" and exit 3 when /whoami returns 401', async () => {
    writeBearer('bad-token');
    // /health is public on loopback (200), but /whoami rejects the bad token.
    const srv = await makeDaemon({
      health: (res) => json(res, 200, { ok: true, version: '0.9.0' }),
      whoami: (res) => json(res, 401, { error: 'unauthorized' }),
    });
    await pointAt(srv.url);
    try {
      const code = await runConnect();
      expect(code).toBe(3);
      expect(readCache()['bearer_status']).toBe('rejected');
      expect(cap.text()).toMatch(/rejected by daemon/);
    } finally {
      await srv.close();
    }
  });

  it('reports bearer_status "unverified" against an older daemon without /whoami (404)', async () => {
    writeBearer('some-token');
    // /whoami route absent → 404 → connect must not claim verified.
    const srv = await makeDaemon({
      health: (res) => json(res, 200, { ok: true, version: '0.5.0' }),
      // no whoami route → makeDaemon returns 404
    });
    await pointAt(srv.url);
    try {
      const code = await runConnect();
      expect(code).toBe(0);
      expect(readCache()['bearer_status']).toBe('unverified');
      expect(cap.text()).toMatch(/unverified/);
    } finally {
      await srv.close();
    }
  });
});
