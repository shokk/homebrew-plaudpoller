import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type Region = 'us' | 'eu';
export type AudioFormat = 'mp3' | 'm4a' | 'original';

export interface WebhookSettings {
  enabled: boolean;
  url: string;
  /** 'metadata' = JSON con path NFS + metadati; 'multipart' = (futuro) file binario */
  mode: 'metadata' | 'multipart';
}

export type VoiceDevice = 'cpu' | 'mps' | 'cuda';

/** Speaker identification (opt-in). Runs the Python sidecar in voice/. */
export interface VoiceSettings {
  enabled: boolean;
  /** Python with pyannote.audio installed; `plaudpoller voices setup` creates this venv. */
  pythonPath: string;
  /** SQLite voiceprint database. */
  dbPath: string;
  device: VoiceDevice;
  /** Minimum cosine similarity for a match. Calibrate on your own recordings. */
  threshold: number;
  /** A match must beat the next-best person by at least this much. */
  margin: number;
  /** Only grow a profile from matches at least this strong. */
  autoEnrollThreshold: number;
  /** Speakers with less speech than this are left unidentified. */
  minSpeechSec: number;
  /** Upper bound passed to diarization; 0 = automatic. */
  maxSpeakers: number;
  /** Create Unknown-NNN profiles for voices that match nobody. */
  createUnknown: boolean;
  /** Add confident matches to the person's profile. */
  autoEnroll: boolean;
}

export interface Settings {
  outputDir: string;
  region: Region;
  audioFormat: AudioFormat;
  includeTrash: boolean;
  pollIntervalMin: number;
  /** minuti per chunk audio (per la trascrizione); 0 = nessun chunk */
  chunkMinutes: number;
  webhook: WebhookSettings;
  voice: VoiceSettings;
}

export const DATA_DIR = process.env.PLAUD_DATA_DIR ?? path.join(os.homedir(), '.plaudpoller');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const LOG_FILE = path.join(DATA_DIR, 'poller.log');

export function defaultSettings(): Settings {
  const fallbackOut =
    process.platform === 'win32'
      ? path.join(process.cwd(), 'test-output')
      : '/mnt/nfs/plaud';
  return {
    outputDir: process.env.PLAUD_OUTPUT_DIR ?? fallbackOut,
    region: (process.env.PLAUD_REGION as Region) ?? 'eu',
    audioFormat: (process.env.PLAUD_AUDIO_FORMAT as AudioFormat) ?? 'mp3',
    includeTrash: process.env.PLAUD_INCLUDE_TRASH === 'true',
    pollIntervalMin: Number(process.env.PLAUD_POLL_INTERVAL_MIN ?? 5),
    chunkMinutes: Number(process.env.PLAUD_CHUNK_MINUTES ?? 10),
    webhook: { enabled: false, url: '', mode: 'metadata' },
    voice: {
      enabled: false,
      pythonPath: path.join(DATA_DIR, 'voice-venv', 'bin', 'python'),
      dbPath: path.join(DATA_DIR, 'voices.db'),
      device: 'cpu',
      threshold: 0.55,
      margin: 0.05,
      autoEnrollThreshold: 0.75,
      minSpeechSec: 10,
      maxSpeakers: 0,
      createUnknown: true,
      autoEnroll: true,
    },
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const d = defaultSettings();
    return {
      ...d,
      ...parsed,
      webhook: { ...d.webhook, ...(parsed.webhook ?? {}) },
      voice: { ...d.voice, ...(parsed.voice ?? {}) },
    };
  } catch {
    return defaultSettings();
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8');
  await fs.rename(tmp, SETTINGS_FILE);
}

/** Validazione/sanitizzazione di un payload settings ricevuto dalla GUI. */
function clampNum(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function sanitizeVoice(input: unknown, d: VoiceSettings): VoiceSettings {
  const v = (input ?? {}) as Record<string, unknown>;
  const str = (x: unknown, fallback: string): string => (typeof x === 'string' && x.trim() ? x.trim() : fallback);
  const bool = (x: unknown, fallback: boolean): boolean => (x === undefined ? fallback : Boolean(x));
  return {
    enabled: bool(v.enabled, d.enabled),
    pythonPath: str(v.pythonPath, d.pythonPath),
    dbPath: str(v.dbPath, d.dbPath),
    device: v.device === 'mps' || v.device === 'cuda' || v.device === 'cpu' ? v.device : d.device,
    threshold: clampNum(v.threshold, d.threshold, 0, 1),
    margin: clampNum(v.margin, d.margin, 0, 1),
    autoEnrollThreshold: clampNum(v.autoEnrollThreshold, d.autoEnrollThreshold, 0, 1),
    minSpeechSec: clampNum(v.minSpeechSec, d.minSpeechSec, 0, 600),
    maxSpeakers: Math.round(clampNum(v.maxSpeakers, d.maxSpeakers, 0, 50)),
    createUnknown: bool(v.createUnknown, d.createUnknown),
    autoEnroll: bool(v.autoEnroll, d.autoEnroll),
  };
}

export function sanitizeSettings(input: unknown): Settings {
  const d = defaultSettings();
  const i = (input ?? {}) as Record<string, unknown>;
  const wh = (i.webhook ?? {}) as Record<string, unknown>;
  return {
    outputDir: typeof i.outputDir === 'string' && i.outputDir.trim() ? i.outputDir : d.outputDir,
    region: i.region === 'us' || i.region === 'eu' ? i.region : d.region,
    audioFormat: i.audioFormat === 'original' ? 'original' : i.audioFormat === 'm4a' ? 'm4a' : 'mp3',
    includeTrash: Boolean(i.includeTrash),
    pollIntervalMin: Math.max(1, Math.min(1440, Number(i.pollIntervalMin) || d.pollIntervalMin)),
    chunkMinutes: Math.max(0, Math.min(60, Number(i.chunkMinutes) ?? d.chunkMinutes)),
    webhook: {
      enabled: Boolean(wh.enabled),
      url: typeof wh.url === 'string' ? wh.url.trim() : '',
      mode: wh.mode === 'multipart' ? 'multipart' : 'metadata',
    },
    voice: sanitizeVoice(i.voice, d.voice),
  };
}
