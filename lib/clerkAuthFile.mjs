// Cross-platform auth.json reader/writer for the cortex CLI.
// Location:
//   POSIX:   $XDG_CONFIG_HOME/cortex/auth.json   (default ~/.config/cortex/auth.json)
//   Windows: %APPDATA%/cortex/auth.json
import { promises as fs } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';

export function authFilePath() {
  if (platform() === 'win32') {
    const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appdata, 'cortex', 'auth.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'cortex', 'auth.json');
}

export async function readAuth() {
  try {
    const raw = await fs.readFile(authFilePath(), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeAuth(data) {
  const p = authFilePath();
  await fs.mkdir(dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2), { mode: 0o600 });
}
