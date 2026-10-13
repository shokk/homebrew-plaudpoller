/**
 * Speaker identification: runs the Python sidecar in voice/ (pyannote diarization +
 * a local SQLite voiceprint database) and reads back speakers.json.
 *
 * The sidecar is opt-in (settings.voice.enabled). pyannote/torch cannot be bundled into
 * the compiled binary, so `plaudpoller voices setup` builds a venv under ~/.plaudpoller/.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './settings.js';
import type { Settings, VoiceSettings } from './settings.js';

const execFileP = promisify(execFile);

type Log = (msg: string) => void;

export interface VoiceSpeaker {
  label: string;
  name: string;
  /** matched = known person, new = Unknown-NNN profile created, unknown = no match, skipped = too little speech */
  status: 'matched' | 'new' | 'unknown' | 'skipped';
  score: number | null;
  margin: number | null;
  candidate: string | null;
  speechSec: number;
  enrolled: boolean;
}

export interface VoiceTurn {
  start: number;
  end: number;
  label: string;
  name: string;
}

export interface VoiceResult {
  version: number;
  model: string;
  speakers: VoiceSpeaker[];
  turns: VoiceTurn[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Where the Python sidecar lives: $PLAUD_VOICE_DIR, a source checkout, or ~/.plaudpoller/voice. */
export async function resolveVoiceDir(): Promise<string> {
  const candidates = [
    process.env.PLAUD_VOICE_DIR,
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'voice'),
    path.join(DATA_DIR, 'voice'),
  ].filter((p): p is string => Boolean(p));
  for (const dir of candidates) {
    if (await exists(path.join(dir, 'identify.py'))) return dir;
  }
  throw new Error('Voice sidecar not installed. Run `plaudpoller voices setup`.');
}

/** Flags every sidecar command understands, taken from settings. */
function commonFlags(v: VoiceSettings): Array<[string, string]> {
  return [
    ['--db', v.dbPath],
    ['--device', v.device],
  ];
}

function identifyFlags(v: VoiceSettings): string[][] {
  const flags: string[][] = [
    ['--threshold', String(v.threshold)],
    ['--margin', String(v.margin)],
    ['--auto-enroll-threshold', String(v.autoEnrollThreshold)],
    ['--min-speech-sec', String(v.minSpeechSec)],
  ];
  if (v.maxSpeakers > 0) flags.push(['--max-speakers', String(v.maxSpeakers)]);
  if (!v.createUnknown) flags.push(['--no-create-unknown']);
  if (!v.autoEnroll) flags.push(['--no-auto-enroll']);
  return flags;
}

async function requirePython(v: VoiceSettings): Promise<void> {
  if (!(await exists(v.pythonPath))) {
    throw new Error(`Python not found at ${v.pythonPath}. Run \`plaudpoller voices setup\`.`);
  }
}

/** Diarize + identify one recording. Writes <dir>/speakers.json and returns it. Throws on failure. */
export async function runVoiceId(s: Settings, audioFile: string, dir: string, log: Log): Promise<VoiceResult> {
  const v = s.voice;
  await requirePython(v);
  const scriptDir = await resolveVoiceDir();
  const out = path.join(dir, 'speakers.json');

  const args = [path.join(scriptDir, 'identify.py'), 'identify', audioFile, '--out', out];
  for (const [flag, value] of commonFlags(v)) args.push(flag, value);
  for (const flag of identifyFlags(v)) args.push(...flag);

  const started = Date.now();
  try {
    await execFileP(v.pythonPath, args, { maxBuffer: 16 * 1024 * 1024, timeout: 60 * 60 * 1000 });
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    const detail = (e.stderr || e.message).trim().split('\n').slice(-3).join(' | ');
    throw new Error(`voice identification failed: ${detail}`);
  }

  const result = JSON.parse(await fs.readFile(out, 'utf8')) as VoiceResult;
  const summary = result.speakers.map((sp) => `${sp.name} (${sp.status})`).join(', ') || 'no speech detected';
  log(`  voice id: ${summary} [${Math.round((Date.now() - started) / 1000)}s]`);
  return result;
}

/** Names worth recording on the entry: known people and Unknown-NNN profiles. */
export function identifiedNames(result: VoiceResult): string[] {
  const names = result.speakers
    .filter((sp) => sp.status === 'matched' || sp.status === 'new')
    .map((sp) => sp.name);
  return [...new Set(names)];
}

/** Read an existing speakers.json (for the webhook payload). */
export async function loadVoiceResult(dir: string): Promise<VoiceResult | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'speakers.json'), 'utf8')) as VoiceResult;
  } catch {
    return undefined;
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

/** `plaudpoller voices <subcommand ...>`: forward to the sidecar, filling in settings-based defaults. */
export async function voicesPassthrough(s: Settings, args: string[]): Promise<number> {
  const v = s.voice;
  await requirePython(v);
  const scriptDir = await resolveVoiceDir();
  const sub = args[0];
  const withDb = ['identify', 'enroll', 'list', 'rename', 'merge', 'forget'].includes(sub);
  const pairs: string[][] = [];
  if (withDb) pairs.push(...commonFlags(v));
  if (sub === 'identify') pairs.push(...identifyFlags(v));
  const extra: string[] = [];
  for (const pair of pairs) {
    if (!args.includes(pair[0])) extra.push(...pair);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(v.pythonPath, [path.join(scriptDir, 'identify.py'), ...args, ...extra], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** One-time install: venv + pyannote, plus the sidecar scripts when running the compiled binary. */
export async function setupVoice(s: Settings, version: string): Promise<void> {
  const v = s.voice;
  await fs.mkdir(DATA_DIR, { recursive: true });

  if (!(await exists(v.pythonPath))) {
    console.log(`Creating Python environment at ${path.dirname(path.dirname(v.pythonPath))} …`);
    await run('python3', ['-m', 'venv', path.dirname(path.dirname(v.pythonPath))]).catch((err) => {
      throw new Error(`Could not create a Python venv (${(err as Error).message}). Install Python 3.9+ first (brew install python).`);
    });
  }

  let scriptDir: string;
  try {
    scriptDir = await resolveVoiceDir();
  } catch {
    const url = `https://github.com/shokk/homebrew-plaudpoller/releases/download/v${version}/plaudpoller-voice.tar.gz`;
    console.log(`Downloading voice sidecar ${url} …`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Could not download the voice sidecar (HTTP ${res.status}). Copy the voice/ folder from the repo to ${path.join(DATA_DIR, 'voice')} and re-run setup.`,
      );
    }
    const tarball = path.join(DATA_DIR, 'plaudpoller-voice.tar.gz');
    await fs.writeFile(tarball, Buffer.from(await res.arrayBuffer()));
    await run('tar', ['-xzf', tarball, '-C', DATA_DIR]);
    await fs.unlink(tarball);
    scriptDir = await resolveVoiceDir();
  }

  console.log('Installing pyannote.audio and torch (this takes a few minutes) …');
  await run(v.pythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  await run(v.pythonPath, ['-m', 'pip', 'install', '-r', path.join(scriptDir, 'requirements.txt')]);

  console.log(`
Voice sidecar installed (${scriptDir}).

Two one-time steps remain:
  1. Hugging Face: accept the model conditions for pyannote/speaker-diarization-3.1 and
     pyannote/segmentation-3.0 (follow any further prompts on those pages), then create a
     read token and export it:   export HF_TOKEN=hf_...
     After the first run the models are cached and everything works offline.
  2. Turn it on:                 plaudpoller config set voice.enabled true

Then enroll yourself from a clip of only you speaking:
  plaudpoller voices enroll "Your Name" clip.m4a
`);
}
