#!/usr/bin/env node
/**
 * Unified CLI entrypoint for the `plaudpoller` binary.
 *
 * Usage:
 *   plaudpoller grab-token   — capture Google auth token via Chrome
 *   plaudpoller poll         — run one poll cycle and exit
 *   plaudpoller serve        — start the web GUI + scheduler
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
