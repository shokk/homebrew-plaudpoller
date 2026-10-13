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

**Rebuild missing audio chunks** — for recordings already downloaded that have no `chunks/` (for example Plaud's Ogg/Opus files from before 1.4.0, which failed to split). Local only, no Plaud login needed:

```bash
plaudpoller rechunk             # only recordings with missing chunks
plaudpoller rechunk --force     # rebuild every recording's chunks
```

**Upgrading to 1.4.0 and checking audio** — after `brew upgrade plaudpoller`, run `plaudpoller version`, then `plaudpoller rechunk` to repair recordings that came in without chunks. To verify a recording came in correctly, look in its folder under `outputDir`:

- `audio.mp3` (or `.m4a`) is non-empty and plays.
- `chunks/` holds `chunk_000.mp3`, `chunk_001.mp3`, … and their durations add up to the audio's length (`ffprobe -v error -show_entries format=duration -of csv=p=0 audio.mp3`).
- The poll log says `audio is opus, not mp3; re-encoding chunks to mp3` for Plaud's Ogg/Opus files. That is expected.
- `~/.plaudpoller/poller.log` has no repeated `ffmpeg chunking failed` lines, and `<outputDir>/.state.json` lists the recording.

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
| `outputDir` | `PLAUD_OUTPUT_DIR` | `/mnt/nfs/plaud` | Where recordings are saved |
| `audioFormat` | `PLAUD_AUDIO_FORMAT` | `mp3` | `mp3` or `m4a` (requires ffmpeg) |
| `pollIntervalMin` | `PLAUD_POLL_INTERVAL_MIN` | `5` | Scheduler interval in minutes |
| `region` | `PLAUD_REGION` | `eu` | `us` or `eu` |
| `chunkMinutes` | `PLAUD_CHUNK_MINUTES` | `10` | Minutes per audio chunk (0 = disabled, requires ffmpeg and ffprobe) |
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
- **Failures and backfill:** a failed identification never blocks a recording. It is retried on later polls, up to 5 attempts, then left alone (the error is kept in `.state.json` as `voiceError`). Recordings downloaded while `voice.enabled` was off are not picked up automatically; run `plaudpoller voices identify <audio>` on them. The webhook can fire before voice data exists if the first attempt fails; it is not re-sent when a retry later succeeds.
- Diarization of a long recording takes minutes on CPU. It runs after all downloads in a poll finish, so it never delays them, but the poll does wait for it.
- **Batch:** `scripts/process-queue.py --queue queue.json --inbox <folder>` runs `voices identify` over audio files named `<recording id>.<ext>` and remembers which ids are done.

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
- [ffmpeg](https://ffmpeg.org/) (includes `ffprobe`) — optional, required for m4a conversion and audio chunking (`brew install ffmpeg`). Chunks are cut losslessly when the audio codec matches its extension; Plaud's Ogg/Opus files saved as `.mp3` are re-encoded to mp3 chunks.
- Python 3.9+ — optional, only for speaker identification (`brew install python`)
