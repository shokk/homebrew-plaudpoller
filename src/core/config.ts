import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import type { PlaudConfig as PlaudConfigData, PlaudCredentials, PlaudTokenData } from './types.js';

const DEFAULT_DIR = path.join(os.homedir(), '.plaud');
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
    '-T', '', // only this app can access without prompting
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

// ── PlaudConfig ───────────────────────────────────────────────────────────────

export class PlaudConfig {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_DIR;
    if (IS_MACOS) this.migrateFromFile();
  }

  // On first run after upgrade, move any plaintext secrets out of the file
  // into the keychain, then scrub them from the file.
  private migrateFromFile(): void {
    const fp = this.filePath();
    let data: PlaudConfigData;
    try {
      data = JSON.parse(fs.readFileSync(fp, 'utf-8')) as PlaudConfigData;
    } catch {
      return;
    }

    let dirty = false;
    if (data.token && !keychainGet('token')) {
      keychainSet('token', JSON.stringify(data.token));
      delete data.token;
      dirty = true;
    }
    if (data.credentials && !keychainGet('credentials')) {
      keychainSet('credentials', JSON.stringify(data.credentials));
      delete data.credentials;
      dirty = true;
    }
    if (dirty) {
      fs.writeFileSync(fp, JSON.stringify(data, null, 2), { mode: 0o600 });
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

  saveToken(token: PlaudTokenData): void {
    if (IS_MACOS) {
      keychainSet('token', JSON.stringify(token));
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
    if (IS_MACOS) {
      const raw = keychainGet('token');
      return raw ? JSON.parse(raw) as PlaudTokenData : undefined;
    }
    return this.loadFile().token;
  }

  getCredentials(): PlaudCredentials | undefined {
    if (IS_MACOS) {
      const raw = keychainGet('credentials');
      return raw ? JSON.parse(raw) as PlaudCredentials : undefined;
    }
    return this.loadFile().credentials;
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
