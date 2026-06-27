#!/usr/bin/env node
/**
 * Unified CLI entrypoint for the `plaud` binary.
 *
 * Usage:
 *   plaud grab-token   — capture Google auth token via Chrome
 *   plaud poll         — run one poll cycle and exit
 *   plaud serve        — start the web GUI + scheduler
 */

const [, , cmd, ...args] = process.argv;

async function main(): Promise<void> {
  switch (cmd) {
    case 'grab-token': {
      const { main: grabToken } = await import('../plaud-grab-token.js');
      await grabToken();
      break;
    }
    case 'poll': {
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
    case 'serve': {
      // server.ts has a self-executing main — just import it.
      await import('../server.js');
      break;
    }
    default: {
      const name = cmd ? `Unknown command: ${cmd}\n\n` : '';
      console.error(`${name}Usage: plaud <command>

Commands:
  grab-token   Capture Google auth token via Chrome (run once to authenticate)
  poll         Run one poll cycle and exit
  serve        Start the web GUI + background scheduler (default port 8787)
`);
      process.exit(cmd ? 1 : 0);
    }
  }
}

main().catch((err) => {
  console.error(`FATAL: ${(err as Error).message}`);
  process.exit(1);
});
