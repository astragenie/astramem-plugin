// astramem config — get/set/unset config values by dot-path key.
// Subcommands: get [key], set <key> <value>, unset <key>.
// Returns 0 on success, 2 on usage error.
import { getValue, setValue, unsetValue } from '../lib/config.ts';

/**
 * Run the `astramem config` subcommand.
 *
 * args[0] = 'get' | 'set' | 'unset'
 * get [key]       — print value at dot-path key, or entire config if no key
 * set <key> <val> — set value at dot-path key (val parsed as JSON if valid, else string)
 * unset <key>     — delete key from config
 *
 * Returns 0 on success, 2 on usage error.
 */
export async function runConfig(args: string[]): Promise<number> {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(CONFIG_HELP);
    return 0;
  }

  switch (sub) {
    case 'get': {
      const key = args[1];
      if (!key) {
        // Print entire config
        const { loadConfig } = await import('../lib/config.ts');
        const config = loadConfig();
        process.stdout.write(JSON.stringify(config, null, 2) + '\n');
        return 0;
      }
      const val = getValue(key);
      if (val === undefined) {
        process.stderr.write(`astramem config: key '${key}' not found\n`);
        return 2;
      }
      process.stdout.write(typeof val === 'string' ? val + '\n' : JSON.stringify(val, null, 2) + '\n');
      return 0;
    }

    case 'set': {
      const key = args[1];
      const rawVal = args[2];
      if (!key || rawVal === undefined) {
        process.stderr.write('astramem config set: requires <key> <value>\n');
        return 2;
      }
      // Parse value as JSON if possible, otherwise treat as string
      let value: unknown = rawVal;
      try {
        value = JSON.parse(rawVal);
      } catch {
        // Use as string
      }
      setValue(key, value);
      process.stdout.write(`set ${key} = ${JSON.stringify(value)}\n`);
      return 0;
    }

    case 'unset': {
      const key = args[1];
      if (!key) {
        process.stderr.write('astramem config unset: requires <key>\n');
        return 2;
      }
      unsetValue(key);
      process.stdout.write(`unset ${key}\n`);
      return 0;
    }

    default: {
      process.stderr.write(`astramem config: unknown subcommand '${sub}'\n`);
      process.stdout.write(CONFIG_HELP);
      return 2;
    }
  }
}

const CONFIG_HELP = `Usage: astramem config <subcommand> [args]

Subcommands:
  get [key]         Print config value at dot-path key (or full config)
  set <key> <val>   Set config value at dot-path key
  unset <key>       Delete config key

Examples:
  astramem config get
  astramem config get local.url
  astramem config set local.url http://127.0.0.1:7777
  astramem config set provider local
  astramem config set project my-project
  astramem config unset saas.bearer
`;
