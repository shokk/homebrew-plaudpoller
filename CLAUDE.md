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

There are no tests or linter configured.

## Architecture

**Two runtime modes:**

1. **One-shot poller** (`plaud-poller.ts`) — calls `runPoll()` once and exits. Use for cron jobs.
2. **GUI server** (`server.ts`) — runs an HTTP server on port 8787, exposes a self-contained dashboard (`dashboard.ts`), and drives an internal scheduler that calls `runPoll()` on the configured interval.

**Core poll logic** lives entirely in `poller-core.ts → runPoll()`:
- Authenticates via `@plaud/core` (token stored in `~/.plaud/config.json`)
- Lists recordings from the Plaud cloud (`region`: `us` | `eu`)
- Downloads new recordings (mp3, optionally converts to m4a via `ffmpeg`)
- Optionally splits audio into chunks via `ffmpeg -f segment`
- Saves `metadata.json`, `transcript.txt`, `summary.txt` per recording under `outputDir/<date>_<id>_<name>/`
- Tracks processed recordings in `outputDir/.state.json` (write-via-tmp-rename pattern)
- Fires an outgoing webhook (POST JSON) for any unnotified entries

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
