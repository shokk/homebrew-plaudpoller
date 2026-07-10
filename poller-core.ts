
import { PlaudConfig, PlaudAuth, PlaudClient } from './src/core/index.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Settings } from './settings.js';

const execFileP = promisify(execFile);

const CONFIG_DIR = process.env.PLAUD_CONFIG_DIR ?? path.join(os.homedir(), '.plaudpoller');

export interface ProcessedEntry {
  id: string;
  filename: string;
  tag: string;
  dir: string;
  audioFile: string;
  savedAt: string;
  startTime: number;
  durationSec: number;
  hasTranscript: boolean;
  hasSummary: boolean;
  chunks: string[];
  notified: boolean;
  mdFile?: string;
  aiEnriched: boolean;
  aiError?: string;
}

export interface State {
  processed: Record<string, ProcessedEntry>;
}

export interface PollResult {
  found: number;
  added: number;
  notified: number;
  errors: number;
  tracked: number;
}

export type Logger = (msg: string) => void;

function stateFile(s: Settings): string {
  return path.join(s.outputDir, '.state.json');
}

async function loadState(s: Settings): Promise<State> {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile(s), 'utf8')) as State;
    if (!parsed.processed) parsed.processed = {};
    return parsed;
  } catch {
    return { processed: {} };
  }
}

async function saveState(s: Settings, state: State): Promise<void> {
  const tmp = `${stateFile(s)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, stateFile(s));
}

function toDate(epoch: number): Date {
  const ms = epoch < 1e12 ? epoch * 1000 : epoch;
  return new Date(ms);
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

function extractTag(filename: string): string {
  const match = filename.match(/\[([^\]]+)\]/);
  return match ? match[1].trim().toLowerCase() : 'default';
}

function recordingDir(s: Settings, rec: { id: string; filename: string; start_time: number }): string {
  const day = toDate(rec.start_time).toISOString().slice(0, 10);
  const tag = extractTag(rec.filename);
  return path.join(s.outputDir, tag, `${day}_${rec.id}_${safeName(rec.filename || 'rec')}`);
}

async function convertToM4a(mp3Path: string, log: Logger): Promise<string> {
  const m4aPath = mp3Path.replace(/\.mp3$/, '.m4a');
  try {
    await execFileP('ffmpeg', ['-y', '-i', mp3Path, '-c:a', 'aac', '-b:a', '128k', m4aPath]);
    await fs.unlink(mp3Path);
    return m4aPath;
  } catch (err) {
    log(`  m4a conversion failed (${(err as Error).message}); keeping mp3`);
    return mp3Path;
  }
}

async function downloadAudioTo(
  client: PlaudClient,
  s: Settings,
  id: string,
  destDir: string,
  log: Logger,
): Promise<string> {
  if (s.audioFormat === 'mp3' || s.audioFormat === 'm4a') {
    const url = await client.getMp3Url(id);
    if (url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`mp3 fetch HTTP ${res.status}`);
      const mp3Dest = path.join(destDir, 'audio.mp3');
      await fs.writeFile(mp3Dest, Buffer.from(await res.arrayBuffer()));
      if (s.audioFormat === 'm4a') return convertToM4a(mp3Dest, log);
      return mp3Dest;
    }
    log(`  mp3 url not available for ${id}, falling back to original`);
  }
  const ab = await client.downloadAudio(id);
  const dest = path.join(destDir, 'audio.bin');
  await fs.writeFile(dest, Buffer.from(ab));
  return dest;
}

/**
 * Spezza l'audio originale in chunk da `minutes` minuti (taglio senza
 * ri-codifica, qualità identica) sotto <destDir>/chunks/. Ritorna i path
 * ordinati. Best-effort: se ffmpeg manca o fallisce, ritorna [].
 */
async function chunkAudio(audioPath: string, destDir: string, minutes: number, log: Logger): Promise<string[]> {
  if (!minutes || minutes <= 0) return [];
  if (!audioPath.endsWith('.mp3') && !audioPath.endsWith('.m4a')) return [];
  const chunkDir = path.join(destDir, 'chunks');
  await fs.mkdir(chunkDir, { recursive: true });
  try {
    await execFileP('ffmpeg', [
      '-y', '-i', audioPath,
      '-f', 'segment',
      '-segment_time', String(Math.round(minutes * 60)),
      '-c', 'copy',
      '-reset_timestamps', '1',
      path.join(chunkDir, `chunk_%03d${path.extname(audioPath)}`),
    ]);
  } catch (err) {
    log(`  ffmpeg chunking failed (${(err as Error).message}); skipping chunks`);
    return [];
  }
  const ext = path.extname(audioPath);
  const files = (await fs.readdir(chunkDir))
    .filter((f) => f.startsWith('chunk_') && f.endsWith(ext))
    .sort();
  return files.map((f) => path.join(chunkDir, f));
}

// ── .md generation ────────────────────────────────────────────────────────────

interface PKMSections {
  candidateActions: string;
  candidateLinks: string;
  routingRecommendation: string;
}

async function callClaudeForPKM(
  apiKey: string,
  detail: { plaudSummary?: string; highlights?: string; transcript?: string; aiCategory?: string },
): Promise<PKMSections> {
  const parts: string[] = [];
  if (detail.plaudSummary) parts.push(`## Plaud Summary\n${detail.plaudSummary}`);
  if (detail.highlights) parts.push(`## Highlights\n${detail.highlights}`);
  if (detail.transcript) parts.push(`## Transcript\n${detail.transcript}`);
  const context = parts.join('\n\n');

  const prompt = `You are a PKM (personal knowledge management) assistant. Based on this ${detail.aiCategory ?? 'recording'}, provide exactly three sections with these exact headers:

## Candidate Actions
Concrete next steps or to-dos surfaced in the recording (bulleted list, or "None identified" if none).

## Candidate Links
Topics, projects, or people worth cross-referencing in a PKM system (bulleted list, or "None identified" if none).

## Routing Recommendation
One sentence on where this note belongs in a personal knowledge management system.

---
${context}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json() as { content?: Array<{ text: string }> };
  const text = data.content?.[0]?.text ?? '';

  const extract = (header: string, next: string): string => {
    const re = new RegExp(`## ${header}\\s*([\\s\\S]*?)(?=## ${next}|$)`, 'i');
    return (text.match(re)?.[1] ?? '').trim();
  };

  return {
    candidateActions: extract('Candidate Actions', 'Candidate Links'),
    candidateLinks: extract('Candidate Links', 'Routing Recommendation'),
    routingRecommendation: extract('Routing Recommendation', '$END$'),
  };
}

function buildMarkdown(params: {
  date: string;
  tag: string;
  filename: string;
  durationSec: number;
  aiCategory?: string;
  aiHeadline?: string;
  usedTemplate?: string;
  plaudSummary?: string;
  highlights?: string;
  transcript?: string;
  pkm?: PKMSections;
  aiEnriched: boolean;
  aiError?: string;
}): string {
  const stubNote = params.aiError
    ? `_AI enrichment failed: ${params.aiError}. Will retry on next poll._`
    : '_Not yet enriched._';

  const section = (header: string, body: string | undefined, fallback = '_None_') =>
    `## ${header}\n${body?.trim() || fallback}`;

  const mins = Math.round(params.durationSec / 60);
  const meta = [
    params.aiCategory && `- **Type:** ${params.aiCategory}`,
    params.aiHeadline && `- **Headline:** ${params.aiHeadline}`,
    `- **Date:** ${params.date}`,
    `- **Tag:** ${params.tag}`,
    `- **Duration:** ${mins} min`,
    params.usedTemplate && `- **Template:** ${params.usedTemplate}`,
  ].filter(Boolean).join('\n');

  return [
    `# ${params.filename}`,
    '',
    section('Context', meta, '_No metadata_'),
    '',
    section('Transcript', params.transcript),
    '',
    section('Highlights', params.highlights),
    '',
    section('Plaud Summary', params.plaudSummary),
    '',
    section('Candidate Actions', params.pkm?.candidateActions ?? (params.aiEnriched ? undefined : stubNote)),
    '',
    section('Candidate Links', params.pkm?.candidateLinks ?? (params.aiEnriched ? undefined : stubNote)),
    '',
    section('Routing Recommendation', params.pkm?.routingRecommendation ?? (params.aiEnriched ? undefined : stubNote)),
  ].join('\n');
}

function mdFilename(rec: { filename: string; start_time: number }, tag: string): string {
  const date = toDate(rec.start_time).toISOString().slice(0, 10);
  const safe = rec.filename.replace(/[/\\:*?"<>|]+/g, '-').slice(0, 120);
  return `${date} - [${tag}] ${safe}.md`;
}

async function enrichWithAI(
  entry: ProcessedEntry,
  detail: { plaudSummary?: string; highlights?: string; transcript?: string; aiCategory?: string },
  apiKey: string,
  log: Logger,
): Promise<void> {
  try {
    const pkm = await callClaudeForPKM(apiKey, detail);
    const mdPath = path.join(entry.dir, mdFilename({ filename: entry.filename, start_time: entry.startTime }, entry.tag));
    const existing = await fs.readFile(mdPath, 'utf8').catch(() => '');
    // Replace the three stub sections with real content
    const updated = existing
      .replace(/## Candidate Actions\n[\s\S]*?(?=\n## |$)/, `## Candidate Actions\n${pkm.candidateActions}\n`)
      .replace(/## Candidate Links\n[\s\S]*?(?=\n## |$)/, `## Candidate Links\n${pkm.candidateLinks}\n`)
      .replace(/## Routing Recommendation\n[\s\S]*/, `## Routing Recommendation\n${pkm.routingRecommendation}\n`);
    await fs.writeFile(mdPath, updated, 'utf8');
    entry.aiEnriched = true;
    delete entry.aiError;
    entry.mdFile = mdPath;
    log(`  AI enrichment complete: ${path.basename(mdPath)}`);
  } catch (err) {
    entry.aiEnriched = false;
    entry.aiError = (err as Error).message;
    log(`  AI enrichment failed (will retry): ${(err as Error).message}`);
  }
}

/** Invia il webhook per una singola registrazione. Throwa in caso di fallimento. */
async function sendWebhook(s: Settings, entry: ProcessedEntry, extra: { transcript?: string; summary?: string; metadata: unknown }): Promise<void> {
  const payload = {
    event: 'new_recording',
    ...entry,
    transcript: extra.transcript ?? null,
    summary: extra.summary ?? null,
    metadata: extra.metadata,
  };
  const res = await fetch(s.webhook.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
}

export async function runPoll(s: Settings, log: Logger): Promise<PollResult> {
  await fs.mkdir(s.outputDir, { recursive: true });

  const config = new PlaudConfig(CONFIG_DIR);
  if (!config.getCredentials() && !config.getToken()) {
    throw new Error(`No credentials found in ${path.join(CONFIG_DIR, 'config.json')}. Run \`npm run grab-token\` first.`);
  }
  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, s.region, undefined, config);
  await auth.getToken(); // fail-fast on auth problems

  const claudeApiKey = config.getClaudeApiKey();

  const state = await loadState(s);
  const recordings = await client.listRecordings();
  log(`Found ${recordings.length} recordings in Plaud cloud.`);

  const result: PollResult = { found: recordings.length, added: 0, notified: 0, errors: 0, tracked: 0 };

  // Re-scan already-processed recordings for title/tag changes and refile if needed
  for (const rec of recordings) {
    const entry = state.processed[rec.id];
    if (!entry) continue;
    if (rec.filename === entry.filename) continue;

    const newTag = extractTag(rec.filename);
    const newDir = recordingDir(s, rec);
    if (newDir === entry.dir) {
      // only filename changed within same tag — update metadata, no move needed
      entry.filename = rec.filename;
      entry.tag = newTag;
      await saveState(s, state);
      log(`Updated filename for ${rec.id}: "${rec.filename}"`);
      continue;
    }

    try {
      await fs.mkdir(path.dirname(newDir), { recursive: true });
      await fs.rename(entry.dir, newDir);
      // Update all stored paths to reflect the new location
      const oldDir = entry.dir;
      entry.dir = newDir;
      entry.filename = rec.filename;
      entry.tag = newTag;
      entry.audioFile = entry.audioFile.replace(oldDir, newDir);
      entry.chunks = entry.chunks.map(c => c.replace(oldDir, newDir));
      await saveState(s, state);
      log(`Refiled ${rec.id} [${entry.tag}→${newTag}]: ${path.basename(oldDir)} → ${path.basename(newDir)}`);
    } catch (err) {
      result.errors++;
      log(`  refile error ${rec.id}: ${(err as Error).message}`);
    }
  }

  for (const rec of recordings) {
    if (rec.is_trash && !s.includeTrash) continue;
    if (state.processed[rec.id]) continue;

    try {
      log(`New: ${rec.id} "${rec.filename}" (${Math.round(rec.duration / 1000)}s)`);
      const dir = recordingDir(s, rec);
      await fs.mkdir(dir, { recursive: true });

      const audioFile = await downloadAudioTo(client, s, rec.id, dir, log);
      const chunks = await chunkAudio(audioFile, dir, s.chunkMinutes, log);
      if (chunks.length) log(`  ${chunks.length} audio chunks created`);
      const detail = await client.getRecording(rec.id);
      await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(detail, null, 2), 'utf8');

      const tag = extractTag(rec.filename);
      const date = toDate(rec.start_time).toISOString().slice(0, 10);

      let mdFile: string | undefined;
      let aiEnriched = false;
      let aiError: string | undefined;

      if (claudeApiKey) {
        // Build initial .md with stubs for the AI sections, then enrich
        const pkm = await callClaudeForPKM(claudeApiKey, detail).catch((err: Error) => {
          aiError = err.message;
          return undefined;
        });
        aiEnriched = Boolean(pkm);
        const md = buildMarkdown({
          date, tag, filename: rec.filename,
          durationSec: Math.round(rec.duration / 1000),
          aiCategory: detail.aiCategory,
          aiHeadline: detail.aiHeadline,
          usedTemplate: detail.usedTemplate,
          plaudSummary: detail.plaudSummary,
          highlights: detail.highlights,
          transcript: detail.transcript,
          pkm,
          aiEnriched,
          aiError,
        });
        mdFile = path.join(dir, mdFilename(rec, tag));
        await fs.writeFile(mdFile, md, 'utf8');
        log(`  note: ${path.basename(mdFile)}${aiEnriched ? ' (AI enriched)' : ' (AI pending retry)'}`);
      } else {
        // No API key — fall back to separate files
        if (detail.transcript) await fs.writeFile(path.join(dir, 'transcript.txt'), detail.transcript, 'utf8');
        if (detail.plaudSummary) await fs.writeFile(path.join(dir, 'summary.txt'), detail.plaudSummary, 'utf8');
      }

      state.processed[rec.id] = {
        id: rec.id,
        filename: rec.filename,
        tag,
        dir,
        audioFile,
        savedAt: new Date().toISOString(),
        startTime: rec.start_time,
        durationSec: Math.round(rec.duration / 1000),
        hasTranscript: Boolean(detail.transcript),
        hasSummary: Boolean(detail.plaudSummary),
        chunks,
        notified: false,
        mdFile,
        aiEnriched,
        aiError,
      };
      await saveState(s, state);
      result.added++;
      log(`  saved to ${dir}`);
    } catch (err) {
      result.errors++;
      log(`  error on ${rec.id}: ${(err as Error).message}`);
    }
  }

  // Retry AI enrichment for entries that previously failed
  if (claudeApiKey) {
    for (const entry of Object.values(state.processed)) {
      if (entry.aiEnriched || !entry.mdFile) continue;
      log(`Retrying AI enrichment for ${entry.id}…`);
      const metaRaw = await fs.readFile(path.join(entry.dir, 'metadata.json'), 'utf8').catch(() => '{}');
      const meta = JSON.parse(metaRaw) as { plaudSummary?: string; highlights?: string; transcript?: string; aiCategory?: string };
      await enrichWithAI(entry, meta, claudeApiKey, log);
      await saveState(s, state);
    }
  }

  // Webhook: fire for any unnotified entries (including from prior runs)
  if (s.webhook.enabled && s.webhook.url) {
    for (const entry of Object.values(state.processed)) {
      if (entry.notified) continue;
      try {
        let transcript: string | undefined;
        let summary: string | undefined;
        let metadata: unknown = {};
        try {
          metadata = JSON.parse(await fs.readFile(path.join(entry.dir, 'metadata.json'), 'utf8'));
          transcript = (metadata as { transcript?: string }).transcript;
          summary = (metadata as { plaudSummary?: string }).plaudSummary;
        } catch {
          /* metadata optional */
        }
        await sendWebhook(s, entry, { transcript, summary, metadata });
        entry.notified = true;
        await saveState(s, state);
        result.notified++;
        log(`  webhook ok: ${entry.id}`);
      } catch (err) {
        result.errors++;
        log(`  webhook error ${entry.id}: ${(err as Error).message}`);
      }
    }
  }

  result.tracked = Object.keys(state.processed).length;
  log(`Done. New: ${result.added}, notified: ${result.notified}, errors: ${result.errors}, tracked: ${result.tracked}`);
  return result;
}

/** Stato dei download per la GUI (lista registrazioni tracciate). */
export async function readState(s: Settings): Promise<State> {
  return loadState(s);
}

/** Scadenza del token Plaud (per la GUI). */
export function readTokenExpiry(): number | null {
  try {
    const config = new PlaudConfig(CONFIG_DIR);
    const t = config.getToken();
    return t?.expiresAt ?? null;
  } catch {
    return null;
  }
}
