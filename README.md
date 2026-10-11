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

## Speaker identification (optional)

PlaudPoller can name the people in a recording by matching their voices against a local database. Everything runs on your machine; no audio leaves it. It is off by default.

```bash
plaudpoller voices setup                      # one-time: Python venv + pyannote.audio (a few minutes)
export HF_TOKEN=hf_...                        # Hugging Face read token; accept the pyannote model terms first
plaudpoller config set voice.enabled true
plaudpoller voices enroll "Your Name" me.m4a  # a clip of only you speaking, 10s or more
```

Each new recording is then diarized and every speaker is matched against the database (SQLite, `~/.plaudpoller/voices.db`). The result is written to `speakers.json` next to the audio, a `Speakers:` line is added to the note, and the same data goes in the webhook payload under `voice`.

- **Unknown voices** get an `Unknown-001`-style profile so the same person is recognised next time. Name them with `plaudpoller voices rename Unknown-001 "Bob Jones"`. If one person ended up with two profiles, `plaudpoller voices merge`.
- **Round tables:** matching is one-to-one within a recording (two speakers can never both be the same person), and a match must beat the runner-up by `voice.margin`, so false matches stay rare as the database grows. Set `voice.maxSpeakers` to bound diarization.
- **Tuning:** the defaults are starting points. Run `plaudpoller voices identify some.m4a --dry-run` to see scores without touching the database, then adjust `voice.threshold` and `voice.margin`.
- **Transcripts:** `speakers.json` has timestamped turns. To label a Whisper transcript: `plaudpoller voices label speakers.json whisper.json --timestamps`.
- Speakers with less than `voice.minSpeechSec` of speech are left unidentified. Confident matches (`voice.autoEnrollThreshold`) are added to the person's profile, at most once per recording.
- Diarization of a long recording takes minutes on CPU, and the poll waits for it.

| Setting | Default | Description |
|---------|---------|-------------|
| `voice.enabled` | `false` | Identify speakers in new recordings |
| `voice.threshold` | `0.55` | Minimum cosine similarity for a match |
| `voice.margin` | `0.05` | Lead over the next-best person required |
| `voice.autoEnrollThreshold` | `0.75` | Only matches this strong grow a profile |
| `voice.minSpeechSec` | `10` | Skip speakers with less speech than this |
| `voice.maxSpeakers` | `0` | Diarization upper bound (0 = automatic) |
| `voice.createUnknown` / `voice.autoEnroll` | `true` | Create `Unknown-NNN` profiles / grow profiles automatically |
| `voice.device` | `cpu` | `cpu`, `mps` or `cuda` |
| `voice.dbPath`, `voice.pythonPath` | `~/.plaudpoller/…` | Database and Python locations |

## Output layout

```
<outputDir>/
  2024-01-15_<id>_<name>/
    audio.mp3          # or audio.m4a
    metadata.json
    transcript.txt
    summary.txt
    speakers.json      # only with voice.enabled
```

## Requirements

- macOS (Apple Silicon or Intel)
- [Google Chrome](https://www.google.com/chrome/) — for `grab-token`
- [ffmpeg](https://ffmpeg.org/) — optional, required for m4a conversion and audio chunking (`brew install ffmpeg`)
