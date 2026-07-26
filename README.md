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

## Configuration

Settings are read from `~/.plaudpoller/settings.json` (or `$PLAUD_DATA_DIR/settings.json`). You can also set them via environment variables.

| Setting | Env var | Default | Description |
|---------|---------|---------|-------------|
| `outputDir` | `PLAUD_OUTPUT_DIR` | `./exports` | Where recordings are saved |
| `audioFormat` | `PLAUD_AUDIO_FORMAT` | `mp3` | `mp3` or `m4a` (requires ffmpeg) |
| `pollIntervalMin` | `PLAUD_POLL_INTERVAL_MIN` | `60` | Scheduler interval in minutes |
| `region` | `PLAUD_REGION` | `us` | `us` or `eu` |
| `chunkMinutes` | `PLAUD_CHUNK_MINUTES` | `0` | Split audio into chunks (0 = disabled, requires ffmpeg) |
| `webhookUrl` | — | — | POST JSON to this URL for each new recording |

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
