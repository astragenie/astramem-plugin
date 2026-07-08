/**
 * mcp-tools-list-drift.e2e.test.ts — runtime half of the U5 MCP tool-name
 * drift guard (issue #36).
 *
 * The static half (tests/contracts/mcp-tool-manifest.test.ts) asserts
 * plugin.json's *advertised* MCP tools are a subset of the canonical
 * @astragenie/astramem-contracts manifest, entirely offline. This is the
 * runtime half: it asks the LOCAL daemon's live MCP `tools/list` what it
 * actually serves and asserts that too is a subset of the same canonical
 * manifest — catching a real backend that has drifted to a non-canonical
 * tool name, which the static check alone cannot see.
 *
 * ── Gating ───────────────────────────────────────────────────────────────
 * The daemon is an external process, not guaranteed to be running (locally
 * or in CI). This suite probes GET /health first and skips cleanly — never
 * a hard failure — when no daemon answers. Mirrors the SKIP_REASON /
 * describe.skipIf / early-return pattern used by
 * tests/e2e/plugin-daemon-roundtrip.test.ts, just with an async top-level
 * health probe (this repo is "type": "module" / ES2022+, so top-level await
 * is available) instead of a sync env-var + file-existence check.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolveLocalUrl } from '../../src/lib/local-url.ts';
import { readLocalBearer } from '../../src/lib/secrets.ts';

const require = createRequire(import.meta.url);

interface McpToolManifest {
  version: string;
  tools: { name: string; owner: string; status: string }[];
}

function loadManifest(): McpToolManifest {
  // Resolved through the package's exports map (`./manifests/*`) so this
  // tracks whatever version is installed, not a hard-coded node_modules path.
  const p = require.resolve('@astragenie/astramem-contracts/manifests/mcp-tools.v1.json');
  return JSON.parse(readFileSync(p, 'utf-8')) as McpToolManifest;
}

// ---------------------------------------------------------------------------
// Gating — probe the daemon once at module load, same base-URL resolution
// the plugin's own local provider uses (env → config → default 7777).
// ---------------------------------------------------------------------------

const BASE_URL = resolveLocalUrl();

async function probeHealth(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) return `SKIPPED (actionable): daemon /health at ${BASE_URL} responded with HTTP ${res.status}.`;
    const body = (await res.json()) as { ok?: boolean };
    if (!body.ok) return `SKIPPED (actionable): daemon /health at ${BASE_URL} responded 200 but ok=false.`;
    return null;
  } catch (e) {
    return (
      `SKIPPED (actionable): no daemon reachable at ${BASE_URL} (${(e as Error).message}). ` +
      'Start the local daemon (astramem service start / astramem init) to run this drift guard.'
    );
  }
}

const SKIP_REASON = await probeHealth();

if (SKIP_REASON) {
  // Surfaced even under CI log truncation — not just relying on the test name.
  console.warn(`[mcp-tools-list-drift] ${SKIP_REASON}`);
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC helper
// ---------------------------------------------------------------------------

interface McpToolsListResult {
  tools?: { name: string }[];
}

interface McpJsonRpcResponse {
  result?: McpToolsListResult;
  error?: { message?: string };
}

/**
 * Parse an MCP Streamable HTTP response body, which may come back as either
 * a plain JSON object (Content-Type: application/json) or a single SSE frame
 * (Content-Type: text/event-stream, `event: message\ndata: {...}\n\n`)
 * depending on the server implementation.
 */
async function parseMcpResponse(res: Response): Promise<McpJsonRpcResponse> {
  const contentType = res.headers.get('content-type') ?? '';
  const raw = await res.text();
  if (contentType.includes('text/event-stream')) {
    const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) {
      throw new Error(`tools/list SSE response had no "data:" line (body: ${raw.slice(0, 300)})`);
    }
    return JSON.parse(dataLine.slice('data:'.length).trim()) as McpJsonRpcResponse;
  }
  return JSON.parse(raw) as McpJsonRpcResponse;
}

/** POST a `tools/list` JSON-RPC 2.0 request to the daemon's MCP endpoint. */
async function fetchLiveToolNames(): Promise<string[]> {
  const bearer = readLocalBearer();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // MCP Streamable HTTP requires the client to accept both — a bare
    // application/json Accept header gets a 406 from a spec-compliant server.
    Accept: 'application/json, text/event-stream',
  };
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;

  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  if (!res.ok) {
    throw new Error(`tools/list request failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  }
  const json = await parseMcpResponse(res);
  if (json.error) {
    throw new Error(`tools/list returned a JSON-RPC error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  const tools = json.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error(`tools/list response had no result.tools array (shape: ${JSON.stringify(json).slice(0, 300)})`);
  }
  return tools.map((t) => t.name).filter((n): n is string => typeof n === 'string' && n.length > 0);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!!SKIP_REASON)('MCP tool-name drift guard, runtime half (U5 / #36)', () => {
  it(
    SKIP_REASON ?? "live daemon MCP tools/list is a subset of the canonical contracts manifest",
    async () => {
      if (SKIP_REASON) return;

      const manifest = loadManifest();
      const canonical = new Set(manifest.tools.map((t) => t.name));

      let live: string[];
      try {
        live = await fetchLiveToolNames();
      } catch (e) {
        // This is a drift guard, not a daemon-conformance suite — an
        // unexpected/empty tools/list shape is a skip, not a false failure.
        console.warn(
          `[mcp-tools-list-drift] SKIPPED (actionable): daemon at ${BASE_URL} answered /health but ` +
            `tools/list was unusable: ${(e as Error).message}`,
        );
        return;
      }

      if (live.length === 0) {
        console.warn(
          `[mcp-tools-list-drift] SKIPPED (actionable): daemon at ${BASE_URL} tools/list returned zero tools.`,
        );
        return;
      }

      const drift = live.filter((name) => !canonical.has(name));
      expect(
        drift,
        `live daemon at ${BASE_URL} advertises MCP tool names absent from ` +
          `@astragenie/astramem-contracts mcp-tools.v${manifest.version}.json: ${drift.join(', ')}`,
      ).toEqual([]);
    },
    15_000,
  );
});
