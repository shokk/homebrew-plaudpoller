#!/usr/bin/env node
/**
 * Unified CLI entrypoint for the `plaudpoller` binary.
 *
 * Usage:
 *   plaudpoller grab-token   — capture Google auth token via Chrome
 *   plaudpoller poll         — run one poll cycle and exit
 *   plaudpoller serve        — start the web GUI + scheduler
 *   plaudpoller config       — view or edit settings from the terminal
 */

import pkg from '../package.json' with { type: 'json' };
import * as os from 'node:os';
import * as path from 'node:path';
import { PlaudConfig } from './core/index.js';
const version = pkg.version;

const [, , cmd, ...args] = process.argv;

async function ensureAuth(): Promise<void> {
  const configDir = process.env.PLAUD_CONFIG_DIR ?? path.join(os.homedir(), '.plaudpoller');
  const config = new PlaudConfig(configDir);
  const hasCreds = config.getCredentials();

  // Email/password: PlaudAuth refreshes the Bearer token automatically.
  if (hasCreds) return;

  // Google auth: pld_ut cookie token (~24h). Re-run grab-token if missing or expired.
  const token = config.getToken();
  const FIVE_MIN = 5 * 60 * 1000;
  const tokenExpired = !token || token.expiresAt < Date.now() + FIVE_MIN;
  const hasCookies = (config.getCookies() ?? []).length > 0;

  if (tokenExpired || !hasCookies) {
    const reason = tokenExpired ? 'Session token expired or missing' : 'Session cookies missing';
    console.log(`${reason}. Launching grab-token…`);
    const { main: grabToken } = await import('../plaud-grab-token.js');
    await grabToken();
  }
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'version':
    case '-v':
    case '--version': {
      console.log(version);
      break;
    }
    case 'grab-token': {
      const { main: grabToken } = await import('../plaud-grab-token.js');
      await grabToken();
      break;
    }
    case 'poll': {
      await ensureAuth();
      const { promises: fs } = await import('node:fs');
      const { runPoll } = await import('../poller-core.js');
      const { loadSettings, LOG_FILE, DATA_DIR } = await import('../settings.js');

      const log = async (msg: string): Promise<void> => {
        const line = `[${new Date().toISOString()}] ${msg}`;
        console.log(line);
        try {
          await fs.mkdir(DATA_DIR, { recursive: true });
          await fs.appendFile(LOG_FILE, line + '\n', 'utf8');
        } catch { /* best-effort */ }
      };

      const settings = await loadSettings();
      const res = await runPoll(settings, (m) => void log(m));
      if (res.errors > 0) process.exitCode = 1;
      break;
    }
    case 'set-claude-key': {
      const key = args[0];
      if (!key) {
        console.error('Usage: plaudpoller set-claude-key <API_KEY>');
        process.exit(1);
      }
      const configDir = process.env.PLAUD_CONFIG_DIR ?? path.join(os.homedir(), '.plaudpoller');
      const config = new PlaudConfig(configDir);
      config.saveClaudeApiKey(key);
      console.log('Claude API key saved to Keychain (service: plaudpoller, account: claude-api-key).');
      break;
    }
    case 'login': {
      const { main: login } = await import('../plaud-login.js');
      await login();
      break;
    }
    case 'config': {
      const { loadSettings, saveSettings, sanitizeSettings } = await import('../settings.js');

      const printConfigUsage = (): void => {
        console.log(`Usage: plaudpoller config [get <key> | set <key> <value>]

With no arguments, prints the full current settings as JSON.

  get                Print the full current settings as JSON (same as no arguments)
  get <key>          Print a single setting's value (dot-notation for nested keys, e.g. webhook.enabled)
  set <key> <value>  Update a single setting and persist it. <value> is parsed as JSON when
                      possible (so booleans/numbers/objects work), otherwise used as a raw string.

Examples:
  plaudpoller config
  plaudpoller config get outputDir
  plaudpoller config get webhook.enabled
  plaudpoller config set pollIntervalMin 10
  plaudpoller config set webhook.enabled true
`);
      };

      const getByPath = (obj: unknown, keyPath: string): unknown => {
        return keyPath.split('.').reduce<unknown>((acc, part) => {
          if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
            return (acc as Record<string, unknown>)[part];
          }
          return undefined;
        }, obj);
      };

      const setByPath = (obj: Record<string, unknown>, keyPath: string, value: unknown): void => {
        const parts = keyPath.split('.');
        let cur = obj;
        for (let i = 0; i < parts.length - 1; i++) {
          const part = parts[i];
          if (typeof cur[part] !== 'object' || cur[part] === null) {
            cur[part] = {};
          }
          cur = cur[part] as Record<string, unknown>;
        }
        cur[parts[parts.length - 1]] = value;
      };

      const sub = args[0];

      if (!sub) {
        const settings = await loadSettings();
        console.log(JSON.stringify(settings, null, 2));
        break;
      }

      if (sub === '--help' || sub === '-h' || sub === 'help') {
        printConfigUsage();
        break;
      }

      if (sub === 'get') {
        const key = args[1];
        if (!key) {
          const settings = await loadSettings();
          console.log(JSON.stringify(settings, null, 2));
          break;
        }
        const settings = await loadSettings();
        const value = getByPath(settings, key);
        if (value === undefined) {
          console.error(`Unknown settings key: ${key}\n`);
          printConfigUsage();
          process.exit(1);
        }
        console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
        break;
      }

      if (sub === 'set') {
        const key = args[1];
        const rawValue = args[2];
        if (!key || rawValue === undefined) {
          console.error('Usage: plaudpoller config set <key> <value>\n');
          printConfigUsage();
          process.exit(1);
        }
        const current = await loadSettings();
        if (getByPath(current, key) === undefined) {
          console.error(`Unknown settings key: ${key}\n`);
          printConfigUsage();
          process.exit(1);
        }

        let parsedValue: unknown;
        try {
          parsedValue = JSON.parse(rawValue);
        } catch {
          parsedValue = rawValue;
        }

        const draft = current as unknown as Record<string, unknown>;
        setByPath(draft, key, parsedValue);
        const sanitized = sanitizeSettings(draft);
        await saveSettings(sanitized);

        const updated = getByPath(sanitized, key);
        console.log(typeof updated === 'string' ? updated : JSON.stringify(updated, null, 2));
        break;
      }

      console.error(`Unknown config subcommand: ${sub}\n`);
      printConfigUsage();
      process.exit(1);
      break;
    }
    case 'serve': {
      await ensureAuth();
      // server.ts has a self-executing main — just import it.
      await import('../server.js');
      break;
    }
    default: {
      const name = cmd ? `Unknown command: ${cmd}\n\n` : '';
      console.error(`${name}Usage: plaudpoller <command>

Commands:
  grab-token         Capture Google auth token via Chrome (run once to authenticate)
  login              Authenticate with email/password (set PLAUD_EMAIL and PLAUD_PASSWORD)
  set-claude-key     Store Anthropic API key in Keychain for AI note enrichment
  poll               Run one poll cycle and exit
  serve              Start the web GUI + background scheduler (default port 8787)
  config             View or edit settings (plaudpoller config --help for details)
  version            Print version number
`);
      process.exit(cmd ? 1 : 0);
    }
  }
}

main().catch((err) => {
  console.error(`FATAL: ${(err as Error).message}`);
  process.exit(1);
});
