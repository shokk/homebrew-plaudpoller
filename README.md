# PlaudPoller

Poll and download recordings from [Plaud.ai](https://www.plaud.ai) to your local machine. Saves audio (mp3 or m4a), transcript, and summary per recording.

## Install

```bash
brew tap shokk/plaudpoller
brew trust shokk/plaudpoller
brew install plaudpoller
```

`brew trust` is required because PlaudPoller is distributed as a pre-built binary from a third-party tap.

## Setup

Authenticate once with your Plaud account via Google:

```bash
plaudpoller grab-token
```

This opens Chrome, waits for you to log in, then saves the token to `~/.plaud/config.json`. You won't need to do this again until the token expires (~24 hours), at which point re-running the command will refresh it.

## Usage

**One-shot poll** — download any new recordings and exit:

```bash
plaudpoller poll
```

**Web GUI + scheduler** — dashboard at `http://localhost:8787` with a configurable poll interval:

```bash
plaudpoller serve
```

**View or edit settings from the terminal** — no need to run `serve` or hand-edit `settings.json`:

```bash
plaudpoller config                          # print the full current settings as JSON
plaudpoller config get outputDir            # print a single setting
plaudpoller config get webhook.enabled      # dot-notation for nested keys
plaudpoller config set pollIntervalMin 10   # update a setting and persist it
plaudpoller config set webhook.enabled true
plaudpoller config --help                   # usage help
```

`config set` parses `<value>` as JSON when possible (so booleans/numbers/objects work), and falls back to a raw string otherwise. Values are validated/normalized the same way the web GUI's settings form is before being written to disk.

## Configuration

Settings are read from `~/.plaudpoller/settings.json` (or `$PLAUD_DATA_DIR/settings.json`). You can also set them via environment variables, or use `plaudpoller config` (see above) to view/edit them directly from the CLI.

| Setting | Env var | Default | Description |
|---------|---------|---------|-------------|
| `outputDir` | `PLAUD_OUTPUT_DIR` | `./exports` | Where recordings are saved |
| `audioFormat` | `PLAUD_AUDIO_FORMAT` | `mp3` | `mp3` or `m4a` (requires ffmpeg) |
| `pollIntervalMin` | `PLAUD_POLL_INTERVAL_MIN` | `60` | Scheduler interval in minutes |
| `region` | `PLAUD_REGION` | `us` | `us` or `eu` |
| `chunkMinutes` | `PLAUD_CHUNK_MINUTES` | `0` | Split audio into chunks (0 = disabled, requires ffmpeg) |
| `includeTrash` | `PLAUD_INCLUDE_TRASH` | `false` | Include recordings in the trash when polling |
| `webhook.enabled` | — | `false` | Enable webhook notifications for new recordings |
| `webhook.url` | — | — | POST JSON (or multipart) to this URL for each new recording |
| `webhook.mode` | — | `metadata` | `metadata` (JSON + path) or `multipart` (binary file) |

## Output layout

```
<outputDir>/
  2024-01-15_<id>_<name>/
    audio.mp3          # or audio.m4a
    metadata.json
    transcript.txt
    summary.txt
```

## Requirements

- macOS (Apple Silicon or Intel)
- [Google Chrome](https://www.google.com/chrome/) — for `grab-token`
- [ffmpeg](https://ffmpeg.org/) — optional, required for m4a conversion and audio chunking (`brew install ffmpeg`)
