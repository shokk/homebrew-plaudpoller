/**
 * plaud-grab-token.ts
 *
 * Opens a dedicated Chrome window, navigates to app.plaud.ai, and waits for
 * you to complete Google login. Once detected, it extracts the bearer token
 * from the page's network requests and saves it to ~/.plaud/config.json in
 * the format expected by @plaud/core.
 *
 * Usage:
 *   npm run grab-token
 *
 * Chrome profile is persisted at ~/.plaud/chrome-profile so Google stays
 * logged in across runs (subsequent grabs skip the Google login step).
 */

import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CDP_PORT = 19_222; // avoid colliding with any existing Chrome debug instance
const PLAUD_ORIGIN = 'https://app.plaud.ai';
const CONFIG_DIR = process.env.PLAUD_CONFIG_DIR ?? path.join(os.homedir(), '.plaud');
const CHROME_PROFILE_DIR = path.join(CONFIG_DIR, 'chrome-profile');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ── Chrome path candidates (macOS + Linux) ───────────────────────────────────

function findChrome(): string {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    'Chrome not found. Install Google Chrome or set CHROME_PATH env var.',
  );
}

// ── Minimal CDP over HTTP + WebSocket ────────────────────────────────────────

function cdpHttp(p: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${CDP_PORT}${p}`, (res) => {
      let buf = '';
      res.on('data', (c: Buffer) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch { reject(new Error(`JSON parse error from CDP ${p}: ${buf}`)); }
      });
    });
    req.on('error', reject);
  });
}

/** Wait for Chrome's CDP endpoint to become available. */
async function waitForCDP(ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await cdpHttp('/json/version');
      return;
    } catch {
      await sleep(400);
    }
  }
  throw new Error('Timed out waiting for Chrome DevTools Protocol.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface CDPTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** Find or create a page target for Plaud. */
async function getPlaudTarget(): Promise<CDPTarget> {
  const targets = (await cdpHttp('/json/list')) as CDPTarget[];
  const existing = targets.find(
    (t) => t.type === 'page' && t.url.startsWith(PLAUD_ORIGIN),
  );
  if (existing) return existing;

  // Open a new tab via CDP
  const newTarget = (await cdpHttp(
    `/json/new?${encodeURIComponent(PLAUD_ORIGIN)}`,
  )) as CDPTarget;
  return newTarget;
}

/** Thin WebSocket wrapper around a single CDP target. */
class CDPSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Map<string, ((params: unknown) => void)[]>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.onmessage = (ev: MessageEvent<string>) => {
      const msg = JSON.parse(ev.data) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result ?? {});
        }
      } else if (msg.method) {
        for (const h of this.eventHandlers.get(msg.method) ?? []) {
          h(msg.params);
        }
      }
    };
  }

  send<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }

  on(event: string, handler: (params: unknown) => void): void {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
    this.eventHandlers.get(event)!.push(handler);
  }
}

async function openSession(target: CDPTarget): Promise<CDPSession> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.onopen = () => resolve(new CDPSession(ws));
    ws.onerror = () => reject(new Error('WebSocket connection to CDP failed'));
  });
}

// ── Token extraction ─────────────────────────────────────────────────────────

function decodeJwtPayload(jwt: string): { iat: number; exp: number } {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('Not a JWT');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as {
    iat: number;
    exp: number;
  };
}

function saveToken(token: string): void {
  const payload = decodeJwtPayload(token);
  const tokenData = {
    accessToken: token,
    tokenType: 'Bearer',
    issuedAt: payload.iat * 1000,
    expiresAt: payload.exp * 1000,
  };
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>; }
  catch { /* first run */ }
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ ...existing, token: tokenData }, null, 2),
    { mode: 0o600 },
  );
  console.log(`\n✓ Token saved to ${CONFIG_FILE}`);
  console.log(`  Expires: ${new Date(tokenData.expiresAt).toLocaleString()}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const chromePath = process.env.CHROME_PATH ?? findChrome();

  console.log('Launching Chrome with remote debugging…');
  const chrome = spawn(
    chromePath,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${CHROME_PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      PLAUD_ORIGIN,
    ],
    { stdio: 'ignore', detached: false },
  );

  chrome.on('error', (err) => {
    console.error('Failed to launch Chrome:', err.message);
    process.exit(1);
  });

  try {
    console.log('Waiting for Chrome DevTools Protocol…');
    await waitForCDP();

    const target = await getPlaudTarget();
    const session = await openSession(target);

    // Enable Network domain so we can intercept request headers
    await session.send('Network.enable');

    console.log('\nChrome is open at app.plaud.ai.');
    console.log('→ Log in with Google if prompted.');
    console.log('→ Waiting for Plaud API token (up to 3 minutes)…\n');

    const token = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out (3 min) waiting for Plaud token.')),
        3 * 60_000,
      );

      session.on('Network.requestWillBeSentExtraInfo', (params) => {
        const p = params as { headers: Record<string, string> };
        const auth = p.headers['authorization'] ?? p.headers['Authorization'] ?? '';
        if (auth.startsWith('Bearer ')) {
          const candidate = auth.slice(7);
          try {
            decodeJwtPayload(candidate); // validate it's a real JWT
            clearTimeout(timer);
            resolve(candidate);
          } catch {
            // not a JWT, skip
          }
        }
      });
    });

    saveToken(token);
  } finally {
    chrome.kill();
  }
}

export { main };

// Run directly when invoked as a standalone script
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  });
}
