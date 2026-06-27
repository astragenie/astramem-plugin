// astramem doctor — diagnose selector resolution, logs, env vars, and config.
// Walks: env vars, config presence + validation, local probe, saas probe, last 5 ingest log lines.
// Always exits 0. Prints a human-readable diagnostic table.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { unifiedConfigDir } from '../lib/datadir.ts';
import { loadConfig } from '../lib/config.ts';
import { readIngestLogTail } from '../lib/log.ts';

/** Run the `astramem doctor` subcommand. Always returns 0. */
export async function runDoctor(): Promise<number> {
  const lines: string[] = [];
  const configDir = unifiedConfigDir();

  // Header
  lines.push('astramem doctor — diagnostics report');
  lines.push('─'.repeat(60));

  // 1. Environment variables
  lines.push('');
  lines.push('ENV VARS');
  const envVars = ['MEMORY_BEARER', 'MEMORY_API_URL', 'ASTRAMEM_PROVIDER'] as const;
  for (const v of envVars) {
    const val = process.env[v];
    if (val) {
      // Scrub bearer-looking values
      const display = v === 'MEMORY_BEARER' ? '[present, redacted]' : val;
      lines.push(`  ${v}=${display}`);
    } else {
      lines.push(`  ${v}=(not set)`);
    }
  }

  // 2. Config file presence + validation
  lines.push('');
  lines.push('CONFIG');
  const cfgPath = join(configDir, 'config.json');
  if (existsSync(cfgPath)) {
    lines.push(`  config.json: ${cfgPath} [present]`);
    try {
      const cfg = loadConfig();
      lines.push(`  provider: ${cfg.provider}`);
      lines.push(`  local.url: ${cfg.local.url ?? '(default: http://127.0.0.1:7777)'}`);
      lines.push(`  saas.url: ${cfg.saas.url ?? '(not configured)'}`);
      lines.push(`  logging.level: ${cfg.logging.level}`);
    } catch (e) {
      lines.push(`  config.json: INVALID — ${(e as Error).message}`);
    }
  } else {
    lines.push(`  config.json: (not found at ${cfgPath})`);
    lines.push('  Using defaults: provider=auto, local.url=http://127.0.0.1:7777');
  }

  // 3. Local daemon probe
  lines.push('');
  lines.push('LOCAL PROBE');
  try {
    const cfg = loadConfig();
    const localUrl = cfg.local.url ?? 'http://127.0.0.1:7777';
    const start = Date.now();
    const resp = await Promise.race([
      fetch(`${localUrl}/health`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    const latency = Date.now() - start;
    if (resp.ok) {
      lines.push(`  local daemon @ ${localUrl}: OK (${latency}ms)`);
    } else {
      lines.push(`  local daemon @ ${localUrl}: HTTP ${resp.status} (${latency}ms)`);
    }
  } catch (e) {
    lines.push(`  local daemon: UNREACHABLE — ${(e as Error).message}`);
  }

  // 4. SaaS probe
  lines.push('');
  lines.push('SAAS PROBE');
  try {
    const cfg = loadConfig();
    const saasUrl = cfg.saas.url;
    if (!saasUrl) {
      lines.push('  saas: (not configured — set config.saas.url)');
    } else {
      const start = Date.now();
      const resp = await Promise.race([
        fetch(`${saasUrl}/health`),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      const latency = Date.now() - start;
      if (resp.ok) {
        lines.push(`  saas @ ${saasUrl}: OK (${latency}ms)`);
      } else {
        lines.push(`  saas @ ${saasUrl}: HTTP ${resp.status} (${latency}ms)`);
      }
    }
  } catch (e) {
    lines.push(`  saas: UNREACHABLE — ${(e as Error).message}`);
  }

  // 5. Last 5 ingest log lines
  lines.push('');
  lines.push('INGEST LOG (last 5 lines)');
  const tail = readIngestLogTail(5);
  if (tail.length === 0) {
    lines.push('  (no entries)');
  } else {
    for (const l of tail) {
      lines.push(`  ${l}`);
    }
  }

  lines.push('');
  lines.push('─'.repeat(60));
  lines.push('');

  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
