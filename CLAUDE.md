# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All scripts use `tsx` for direct TypeScript execution (no build step needed for development).

```bash
# Google auth login — opens Chrome, wait for Google login, token auto-saved
npm run grab-token

# Email/password login (alternative, not needed for Google auth)
PLAUD_EMAIL=you@example.com PLAUD_PASSWORD=secret npm run login

# Run a single poll cycle and exit
npm run poll

# Start the web GUI + scheduler (default port 8787)
npm run start

# Update the @plaud/core submodule to latest
npm run update-core
```

Type-check without emitting:
```bash
npx tsc --noEmit
```

There is no linter. The only tests are for the Python voice sidecar (no torch/pyannote needed):
```bash
npm run test:voice
```

## Architecture

**Two runtime modes:**

1. **One-shot poller** (`plaud-poller.ts`) — calls `runPoll()` once and exits. Use for cron jobs.
2. **GUI server** (`server.ts`) — runs an HTTP server on port 8787, exposes a self-contained dashboard (`dashboard.ts`), and drives an internal scheduler that calls `runPoll()` on the configured interval.

**Core poll logic** lives entirely in `poller-core.ts → runPoll()`:
- Authenticates via `@plaud/core` (token stored in `~/.plaud/config.json`)
- Lists recordings from the Plaud cloud (`region`: `us` | `eu`)
- Downloads new recordings (mp3, optionally converts to m4a via `ffmpeg`)
- Optionally splits audio into chunks via `ffmpeg -f segment` (lossless copy when the codec matches the extension; Plaud's Ogg/Opus files saved as `audio.mp3` are re-encoded to real mp3 chunks)
- Saves `metadata.json`, `transcript.txt`, `summary.txt` per recording under `outputDir/<date>_<id>_<name>/`
- Tracks processed recordings in `outputDir/.state.json` (write-via-tmp-rename pattern)
- Fires an outgoing webhook (POST JSON) for any unnotified entries

**Speaker identification** (opt-in, `settings.voice.enabled`) — `voice.ts` runs the Python sidecar in `voice/` (`identify.py`: pyannote diarization + embeddings; `store.py`: SQLite voiceprint DB; `matching.py`: threshold + margin + one-to-one assignment; `align.py`: merge turns into a Whisper transcript). `runPoll()` marks each new entry `voicePending` when it downloads it, then runs identification for pending entries after all downloads finish (so a long diarization never delays downloads), on the full file (not the chunks). It writes `speakers.json` into the recording dir and records `speakers`/`voiceDone`/`voiceError`/`voiceAttempts` on the `ProcessedEntry`. Failures never block a recording; failed entries are retried on later polls, up to 5 attempts. `scripts/process-queue.py` batch-runs `voices identify` over audio files named `<recording id>.<ext>` in an inbox folder. pyannote can't be bundled into the `bun --compile` binary, so `plaudpoller voices setup` builds a venv in `~/.plaudpoller/voice-venv` and downloads the `plaudpoller-voice.tar.gz` release asset (the scripts only). The Python modules use sibling imports so the `voice/` folder stays self-contained.

**Settings** (`settings.ts`) layer: env vars → `~/.plaudpoller/settings.json` → hardcoded defaults. `sanitizeSettings()` validates GUI input before persisting.

**`@plaud/core`** is a local git submodule at `plaud-toolkit/`. Its public API (`PlaudConfig`, `PlaudAuth`, `PlaudClient`) handles authentication, token refresh, and API calls. Never import from submodule paths directly — use the `@plaud/core` package alias.

**Data layout at runtime:**
```
~/.plaudpoller/    # PLAUD_DATA_DIR (default: ~/.plaudpoller)
  settings.json
  poller.log

<outputDir>/       # PLAUD_OUTPUT_DIR (default: /mnt/nfs/plaud)
  .state.json
  2024-01-15_<id>_<name>/
    audio.mp3
    metadata.json
    transcript.txt
    summary.txt
    chunks/
      chunk_000.mp3 …
```

**Key env vars:** `PLAUD_DATA_DIR`, `PLAUD_OUTPUT_DIR`, `PLAUD_REGION`, `PLAUD_AUDIO_FORMAT`, `PLAUD_POLL_INTERVAL_MIN`, `PLAUD_CHUNK_MINUTES`, `PLAUD_GUI_PORT`, `PLAUD_GUI_USER`, `PLAUD_GUI_PASSWORD`, `PLAUD_CONFIG_DIR`.

HTTP Basic auth on the GUI is opt-in — set `PLAUD_GUI_PASSWORD` to enable it.
