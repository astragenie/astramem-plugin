/**
 * MCP tool-name drift guard (U5 / issue #36).
 *
 * The plugin does not define its own MCP tools — it proxies straight to the
 * daemon's MCP server (`.mcp.json` → `${MEMORY_API_URL}/mcp`). The tool
 * vocabulary is owned by the single cross-repo source of truth:
 * `@astragenie/astramem-contracts`'s `manifests/mcp-tools.v1.json`.
 *
 * This is the *static* half of the U5 drift guard: it asserts every MCP tool
 * name the plugin advertises to users (in `plugin.json`'s description) is a
 * real, canonical tool in that manifest — so plugin docs can't drift to a
 * non-canonical / renamed / dropped tool name without a test failing. The
 * *runtime* half (assert each live backend's `tools/list` ⊆ manifest) needs a
 * running daemon and belongs in the e2e suite; see #36.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

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

/** Extract the tool names the plugin advertises in plugin.json's description. */
function loadAdvertisedToolNames(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const pluginJsonPath = join(here, '..', '..', '.claude-plugin', 'plugin.json');
  const { description } = JSON.parse(readFileSync(pluginJsonPath, 'utf-8')) as { description: string };

  const m = description.match(/Exposes (\d+) MCP tools?:\s*([^.]+)/);
  if (!m) {
    throw new Error(
      'plugin.json description no longer lists MCP tools in the expected ' +
        '"Exposes N MCP tools: a, b, c." form — update this guard or the description.',
    );
  }
  const declaredCount = Number(m[1]);
  const names = m[2].split(',').map((s) => s.trim()).filter(Boolean);
  // The prose count and the actual list must agree — a mismatch is itself drift.
  expect(names.length, 'plugin.json "Exposes N MCP tools" count disagrees with the listed names').toBe(declaredCount);
  return names;
}

describe('MCP tool-name drift guard (U5 / #36)', () => {
  it('every tool advertised in plugin.json is a canonical tool in the contracts manifest', () => {
    const manifest = loadManifest();
    const canonical = new Set(manifest.tools.map((t) => t.name));
    const advertised = loadAdvertisedToolNames();

    const drift = advertised.filter((name) => !canonical.has(name));
    expect(
      drift,
      `plugin.json advertises MCP tool names absent from ` +
        `@astragenie/astramem-contracts mcp-tools.v${manifest.version}.json: ${drift.join(', ')}`,
    ).toEqual([]);
  });

  it('contracts manifest is the expected v1 shape with a non-empty tool set', () => {
    const manifest = loadManifest();
    expect(manifest.version).toBe('1');
    expect(manifest.tools.length).toBeGreaterThanOrEqual(15);
    for (const t of manifest.tools) {
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
    }
  });
});
