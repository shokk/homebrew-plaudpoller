/**
 * plaud-grab-token.ts
 *
 * Opens a dedicated Chrome window, navigates to app.plaud.ai, and waits for
 * you to complete Google login. Once detected, it extracts the bearer token
 * from the page's network requests and saves it to the macOS Keychain
 * (service: plaudpoller).
 *
 * Usage:
 *   npm run grab-token
 *
 * Chrome profile is persisted at ~/.plaudpoller/chrome-profile so Google stays
 * logged in across runs (subsequent grabs skip the Google login step).
 */

import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlaudConfig } from './src/core/index.js';

const CDP_PORT = 19_222; // avoid colliding with any existing Chrome debug instance
const PLAUD_ORIGIN = 'https://app.plaud.ai';
const CONFIG_DIR = process.env.PLAUD_CONFIG_DIR ?? path.join(os.homedir(), '.plaudpoller');
const CHROME_PROFILE_DIR = path.join(CONFIG_DIR, 'chrome-profile');

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

function cdpHttp(p: string, method: 'GET' | 'PUT' = 'GET'): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${CDP_PORT}${p}`,
      { method },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => { buf += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); }
          catch { reject(new Error(`JSON parse error from CDP ${p}: ${buf}`)); }
        });
      },
    );
    req.on('error', reject);
    req.end();
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
    'PUT',
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

async function fetchCookies(session: CDPSession): Promise<Array<{ name: string; value: string; domain: string; expires?: number }>> {
  const result = await session.send<{ cookies: Array<{ name: string; value: string; domain: string; expires: number }> }>(
    'Network.getCookies',
    { urls: ['https://api.plaud.ai', 'https://web.plaud.ai', 'https://app.plaud.ai'] },
  );
  return result.cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    expires: c.expires > 0 ? c.expires : undefined,
  }));
}

function saveAuth(token: string, cookies: Array<{ name: string; value: string; domain: string; expires?: number }>): void {
  const payload = decodeJwtPayload(token);
  const tokenData = {
    accessToken: token,
    tokenType: 'Bearer',
    issuedAt: payload.iat * 1000,
    expiresAt: payload.exp * 1000,
  };
  const config = new PlaudConfig(CONFIG_DIR);
  config.saveAuth(tokenData, cookies);
  console.log('\n✓ Auth saved to Keychain (service: plaudpoller, account: auth)');
  console.log(`  Token expires: ${new Date(tokenData.expiresAt).toLocaleString()}`);
  console.log(`  Cookies saved: ${cookies.length}`);
}

// ── Chrome session helpers ────────────────────────────────────────────────────

function spawnChrome(chromePath: string, extraArgs: string[] = []) {
  return spawn(
    chromePath,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${CHROME_PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...extraArgs,
      PLAUD_ORIGIN,
    ],
    { stdio: 'ignore', detached: false },
  );
}

async function pollForToken(session: CDPSession, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const check = async () => {
      try {
        const result = await session.send<{ cookies: Array<{ name: string; value: string }> }>(
          'Network.getCookies',
          { urls: ['https://web.plaud.ai', 'https://app.plaud.ai', 'https://api.plaud.ai'] },
        );
        const ut = result.cookies.find(c => c.name === 'pld_ut');
        if (ut) { clearTimeout(timer); resolve(ut.value); }
        else setTimeout(() => void check(), 2000);
      } catch {
        setTimeout(() => void check(), 2000);
      }
    };
    void check();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const chromePath = process.env.CHROME_PATH ?? findChrome();

  // ── Step 1: try headless — silent refresh when Google session is still alive ──
  console.log('Attempting silent session refresh (headless)…');
  const headless = spawnChrome(chromePath, ['--headless=new', '--disable-gpu']);
  headless.on('error', () => { /* will fall through to headed */ });

  let didSilentRefresh = false;
  try {
    await waitForCDP(8_000);
    const target = await getPlaudTarget();
    const session = await openSession(target);
    await session.send('Network.enable');

    const token = await pollForToken(session, 12_000);
    if (token) {
      const cookies = await fetchCookies(session);
      saveAuth(token, cookies);
      didSilentRefresh = true;
      console.log('✓ Silent refresh complete — no interaction required.');
    }
  } catch {
    // headless failed to start or connect; fall through
  } finally {
    headless.kill();
  }

  if (didSilentRefresh) return;

  // ── Step 2: fall back to headed Chrome for interactive Google login ──────────
  console.log('\nSilent refresh failed (Google session may have expired).');
  console.log('Launching Chrome for interactive login…');
  const chrome = spawnChrome(chromePath);
  chrome.on('error', (err) => {
    console.error('Failed to launch Chrome:', err.message);
    process.exit(1);
  });

  try {
    await waitForCDP(10_000);
    const target = await getPlaudTarget();
    const session = await openSession(target);
    await session.send('Network.enable');

    console.log('\nChrome is open at app.plaud.ai.');
    console.log('→ Log in with Google if prompted.');
    console.log('→ Waiting for Plaud session token (up to 3 minutes)…\n');

    const token = await pollForToken(session, 3 * 60_000);
    if (!token) throw new Error('Timed out (3 min) waiting for pld_ut cookie.');

    const cookies = await fetchCookies(session);
    saveAuth(token, cookies);
  } finally {
    chrome.kill();
  }
}

export { main };

// Run directly when invoked as a standalone script
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  });
}
