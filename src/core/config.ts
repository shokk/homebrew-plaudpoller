import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import type { PlaudConfig as PlaudConfigData, PlaudCredentials, PlaudTokenData, PlaudCookie } from './types.js';

const DEFAULT_DIR = path.join(os.homedir(), '.plaudpoller');
const CONFIG_FILE = 'config.json';
const KEYCHAIN_SERVICE = 'plaudpoller';
const IS_MACOS = process.platform === 'darwin';

// ── Keychain helpers (macOS only) ────────────────────────────────────────────

function keychainGet(account: string): string | undefined {
  try {
    const out = execFileSync('security', [
      'find-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', account,
      '-w',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

function keychainSet(account: string, value: string): void {
  // Delete existing entry first (add fails if it already exists)
  try {
    execFileSync('security', [
      'delete-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', account,
    ], { stdio: 'ignore' });
  } catch { /* not present, fine */ }

  execFileSync('security', [
    'add-generic-password',
    '-s', KEYCHAIN_SERVICE,
    '-a', account,
    '-w', value,
    '-T', process.execPath, // trust this binary so "Always Allow" persists across sessions
  ], { stdio: 'ignore' });
}

function keychainDelete(account: string): void {
  try {
    execFileSync('security', [
      'delete-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', account,
    ], { stdio: 'ignore' });
  } catch { /* not present, fine */ }
}

// ── Auth bundle (token + cookies in one Keychain entry) ──────────────────────

interface AuthBundle {
  token?: PlaudTokenData;
  cookies?: PlaudCookie[];
}

function keychainGetAuth(): AuthBundle {
  const raw = keychainGet('auth');
  return raw ? JSON.parse(raw) as AuthBundle : {};
}

// ── PlaudConfig ───────────────────────────────────────────────────────────────

export class PlaudConfig {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_DIR;
    if (IS_MACOS) this.migrate();
  }

  // Migrate plaintext file secrets → Keychain, and old separate token/cookies
  // entries → single consolidated 'auth' entry.
  private migrate(): void {
    // Phase 1: file → keychain (legacy, pre-keychain builds)
    const fp = this.filePath();
    let data: PlaudConfigData;
    try {
      data = JSON.parse(fs.readFileSync(fp, 'utf-8')) as PlaudConfigData;
    } catch {
      data = {};
    }
    let dirty = false;
    if (data.credentials && !keychainGet('credentials')) {
      keychainSet('credentials', JSON.stringify(data.credentials));
      delete data.credentials;
      dirty = true;
    }
    if (dirty) {
      fs.writeFileSync(fp, JSON.stringify(data, null, 2), { mode: 0o600 });
    }

    // Phase 2: separate 'token' + 'cookies' entries → single 'auth' entry
    if (!keychainGet('auth')) {
      const oldToken = keychainGet('token');
      const oldCookies = keychainGet('cookies');
      if (oldToken || oldCookies) {
        const bundle: AuthBundle = {};
        if (oldToken) bundle.token = JSON.parse(oldToken) as PlaudTokenData;
        if (oldCookies) bundle.cookies = JSON.parse(oldCookies) as PlaudCookie[];
        keychainSet('auth', JSON.stringify(bundle));
        keychainDelete('token');
        keychainDelete('cookies');
      }
    }
  }

  private filePath(): string {
    return path.join(this.dir, CONFIG_FILE);
  }

  // File storage is still used for non-secret settings (e.g. region, outputDir)
  private loadFile(): PlaudConfigData {
    try {
      return JSON.parse(fs.readFileSync(this.filePath(), 'utf-8')) as PlaudConfigData;
    } catch {
      return {};
    }
  }

  private saveFile(data: PlaudConfigData): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const existing = this.loadFile();
    const merged = { ...existing, ...data };
    // Never write secrets to the file
    delete merged.token;
    delete merged.credentials;
    fs.writeFileSync(this.filePath(), JSON.stringify(merged, null, 2), { mode: 0o600 });
  }

  // Save token + cookies together in one Keychain write → one prompt.
  saveAuth(token: PlaudTokenData, cookies: PlaudCookie[]): void {
    if (IS_MACOS) {
      keychainSet('auth', JSON.stringify({ token, cookies } satisfies AuthBundle));
    } else {
      this.saveFile({ token, cookies });
    }
  }

  saveToken(token: PlaudTokenData): void {
    if (IS_MACOS) {
      const bundle = keychainGetAuth();
      bundle.token = token;
      keychainSet('auth', JSON.stringify(bundle));
    } else {
      this.saveFile({ token });
    }
  }

  saveCredentials(credentials: PlaudCredentials): void {
    if (IS_MACOS) {
      keychainSet('credentials', JSON.stringify(credentials));
    } else {
      this.saveFile({ credentials });
    }
  }

  getToken(): PlaudTokenData | undefined {
    if (IS_MACOS) return keychainGetAuth().token;
    return this.loadFile().token;
  }

  getCredentials(): PlaudCredentials | undefined {
    if (IS_MACOS) {
      const raw = keychainGet('credentials');
      return raw ? JSON.parse(raw) as PlaudCredentials : undefined;
    }
    return this.loadFile().credentials;
  }

  saveCookies(cookies: PlaudCookie[]): void {
    if (IS_MACOS) {
      const bundle = keychainGetAuth();
      bundle.cookies = cookies;
      keychainSet('auth', JSON.stringify(bundle));
    } else {
      this.saveFile({ cookies });
    }
  }

  getCookies(): PlaudCookie[] | undefined {
    if (IS_MACOS) return keychainGetAuth().cookies;
    return this.loadFile().cookies;
  }

  saveClaudeApiKey(key: string): void {
    if (IS_MACOS) keychainSet('claude-api-key', key);
    else this.saveFile({ claudeApiKey: key } as any);
  }

  getClaudeApiKey(): string | undefined {
    if (IS_MACOS) return keychainGet('claude-api-key');
    return (this.loadFile() as any).claudeApiKey as string | undefined;
  }

  // Non-secret settings (kept in file on all platforms)
  load(): PlaudConfigData {
    const file = this.loadFile();
    return {
      ...file,
      token: this.getToken(),
      credentials: this.getCredentials(),
    };
  }
}
