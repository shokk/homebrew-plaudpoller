#!/usr/bin/env python3
"""PlaudPoller voice profiling sidecar.

Diarizes a recording with pyannote, then names each diarized speaker by
matching its voice embedding against a local SQLite voiceprint database.

  identify.py identify AUDIO --out speakers.json     name the speakers in a recording
  identify.py enroll NAME AUDIO                      enroll a person from a clip of them speaking
  identify.py list                                   show who is in the database
  identify.py rename OLD NEW                         e.g. Unknown-007 "Bob Jones"
  identify.py merge SRC DST                          fold one profile into another
  identify.py forget NAME                            delete a profile
  identify.py label SPEAKERS_JSON WHISPER_JSON       merge turns into a whisper transcript

Everything runs locally. pyannote and torch are imported lazily, so the
database and matching code work (and are tested) without them.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from typing import List, Optional

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from align import label_segments, to_text  # noqa: E402
from matching import MatchConfig, match_speakers, should_auto_enroll  # noqa: E402
from store import StoreError, VoiceStore, unit_vector  # noqa: E402

DEFAULT_MODEL = "pyannote/speaker-diarization-3.1"
DEFAULT_DB = os.environ.get("PLAUDPOLLER_VOICE_DB") or os.path.join(
    os.path.expanduser("~"), ".plaudpoller", "voices.db"
)


@dataclass
class Diarization:
    labels: List[str]
    embeddings: np.ndarray  # K x D, row i belongs to labels[i]
    speech_sec: List[float]
    turns: List[dict]  # {"start", "end", "label"}


@dataclass
class Options:
    threshold: float = 0.55
    margin: float = 0.05
    auto_enroll_threshold: float = 0.75
    min_speech_sec: float = 10.0
    create_unknown: bool = True
    auto_enroll: bool = True
    dry_run: bool = False
    max_embeddings: int = 20
    source: str = ""


# -- core flow (no pyannote needed) -------------------------------------------


def process(diar: Diarization, store: VoiceStore, model: str, opts: Options) -> dict:
    """Name every diarized speaker; returns the speakers.json payload."""
    cfg = MatchConfig(opts.threshold, opts.margin, opts.auto_enroll_threshold)
    k = len(diar.labels)
    emb = np.asarray(diar.embeddings, dtype=np.float32).reshape(k, -1) if k else np.empty((0, 0), dtype=np.float32)

    entries = []
    usable = []
    for i, label in enumerate(diar.labels):
        good = (
            diar.speech_sec[i] >= opts.min_speech_sec
            and bool(np.all(np.isfinite(emb[i])))
            and float(np.linalg.norm(emb[i])) > 0.0
        )
        usable.append(good)
        entries.append(
            {
                "label": label,
                "name": label,
                "status": "skipped",
                "score": None,
                "margin": None,
                "candidate": None,
                "speechSec": round(float(diar.speech_sec[i]), 1),
                "enrolled": False,
            }
        )

    dim = int(emb.shape[1]) if k else 0
    if any(usable):
        store.ensure_model(model, dim)
        idx = [i for i in range(k) if usable[i]]
        sub = np.stack([unit_vector(emb[i]) for i in idx])
        ids, matrix = store.load_matrix()
        matches = match_speakers(sub, ids, matrix, cfg)
        names = store.names()
        for row, (i, m) in enumerate(zip(idx, matches)):
            e = entries[i]
            e["score"] = round(m.score, 4)
            e["margin"] = round(m.margin, 4)
            e["candidate"] = names.get(m.candidate_id) if m.candidate_id is not None else None
            sec = float(diar.speech_sec[i])
            if m.status == "matched":
                e["status"] = "matched"
                e["name"] = names[m.speaker_id]
                # One embedding per recording per person: re-running a file must not inflate a profile.
                if (
                    not opts.dry_run
                    and opts.auto_enroll
                    and should_auto_enroll(m, cfg)
                    and not store.has_embedding_from(m.speaker_id, opts.source)
                ):
                    store.add_embedding(
                        m.speaker_id, sub[row], source=opts.source, speech_sec=sec,
                        max_per_speaker=opts.max_embeddings,
                    )
                    e["enrolled"] = True
            elif opts.create_unknown and not opts.dry_run:
                name = store.next_placeholder_name()
                sid = store.add_speaker(name, placeholder=True)
                store.add_embedding(
                    sid, sub[row], source=opts.source, speech_sec=sec, max_per_speaker=opts.max_embeddings
                )
                e["status"] = "new"
                e["name"] = name
            else:
                e["status"] = "unknown"

    by_label = {e["label"]: e["name"] for e in entries}
    turns = [
        {
            "start": round(float(t["start"]), 2),
            "end": round(float(t["end"]), 2),
            "label": t["label"],
            "name": by_label.get(t["label"], t["label"]),
        }
        for t in diar.turns
    ]
    return {
        "version": 1,
        "audio": opts.source,
        "model": model,
        "dim": dim,
        "dryRun": opts.dry_run,
        "thresholds": {
            "threshold": opts.threshold,
            "margin": opts.margin,
            "autoEnroll": opts.auto_enroll_threshold,
            "minSpeechSec": opts.min_speech_sec,
        },
        "speakers": entries,
        "turns": turns,
    }


# -- pyannote ------------------------------------------------------------------


def _to_wav(audio: str):
    """pyannote reads wav reliably; convert mp3/m4a with ffmpeg when it is available."""
    if audio.lower().endswith(".wav") or not shutil.which("ffmpeg"):
        return audio, None
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    result = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", audio, "-ac", "1", "-ar", "16000", tmp.name],
        capture_output=True,
    )
    if result.returncode != 0:
        os.unlink(tmp.name)
        return audio, None
    return tmp.name, tmp.name


def run_pyannote(
    audio: str,
    model: str,
    token: Optional[str],
    device: str,
    num_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
) -> Diarization:
    try:
        import torch
        from pyannote.audio import Pipeline
    except ImportError as err:
        raise SystemExit(
            f"error: {err}. Run `plaudpoller voices setup` to install pyannote.audio and torch."
        )

    try:
        pipeline = Pipeline.from_pretrained(model, use_auth_token=token)
    except TypeError:  # newer pyannote renamed the argument
        pipeline = Pipeline.from_pretrained(model, token=token)
    if pipeline is None:
        raise SystemExit(
            f"error: could not load '{model}'. Accept its licence on huggingface.co, "
            "then set HF_TOKEN (or run `huggingface-cli login`)."
        )
    if device != "cpu":
        pipeline.to(torch.device(device))

    kwargs = {}
    if num_speakers:
        kwargs["num_speakers"] = num_speakers
    elif max_speakers:
        kwargs["max_speakers"] = max_speakers

    wav, cleanup = _to_wav(audio)
    try:
        out = pipeline(wav, return_embeddings=True, **kwargs)
    finally:
        if cleanup:
            os.unlink(cleanup)

    if not isinstance(out, tuple) or len(out) != 2:
        raise SystemExit(
            "error: this pyannote.audio version did not return speaker embeddings. "
            "Install a 3.x release (pip install 'pyannote.audio>=3.3,<4')."
        )
    diarization, embeddings = out
    labels = list(diarization.labels())
    return Diarization(
        labels=labels,
        embeddings=np.asarray(embeddings, dtype=np.float32).reshape(len(labels), -1) if labels else np.empty((0, 0)),
        speech_sec=[float(diarization.label_duration(label)) for label in labels],
        turns=[
            {"start": turn.start, "end": turn.end, "label": label}
            for turn, _, label in diarization.itertracks(yield_label=True)
        ],
    )


# -- commands ------------------------------------------------------------------


def _write_json(path: str, payload: dict) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    os.replace(tmp, path)


def _token(args) -> Optional[str]:
    return args.hf_token or os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")


def cmd_identify(args) -> int:
    diar = run_pyannote(
        args.audio, args.model, _token(args), args.device,
        max_speakers=args.max_speakers or None,
    )
    opts = Options(
        threshold=args.threshold,
        margin=args.margin,
        auto_enroll_threshold=args.auto_enroll_threshold,
        min_speech_sec=args.min_speech_sec,
        create_unknown=not args.no_create_unknown,
        auto_enroll=not args.no_auto_enroll,
        dry_run=args.dry_run,
        max_embeddings=args.max_embeddings,
        source=os.path.basename(args.audio),
    )
    with VoiceStore(args.db) as store:
        payload = process(diar, store, args.model, opts)
    if args.out:
        _write_json(args.out, payload)
    else:
        json.dump(payload, sys.stdout, indent=2)
        print()
    for e in payload["speakers"]:
        score = "-" if e["score"] is None else f"{e['score']:.2f}"
        print(f"{e['label']:>11} -> {e['name']:<20} {e['status']:<8} score={score} speech={e['speechSec']}s",
              file=sys.stderr)
    return 0


def cmd_enroll(args) -> int:
    diar = run_pyannote(args.audio, args.model, _token(args), args.device, num_speakers=1)
    if len(diar.labels) != 1:
        print("error: no speech found in that clip", file=sys.stderr)
        return 2
    if diar.speech_sec[0] < args.min_speech_sec:
        print(
            f"error: only {diar.speech_sec[0]:.1f}s of speech found; need at least {args.min_speech_sec:.0f}s. "
            "Use a longer clip with only this person speaking.",
            file=sys.stderr,
        )
        return 2
    with VoiceStore(args.db) as store:
        store.ensure_model(args.model, int(diar.embeddings.shape[1]))
        sid = store.get_or_add_speaker(args.name)
        store.add_embedding(
            sid, diar.embeddings[0], source=os.path.basename(args.audio), manual=True,
            speech_sec=diar.speech_sec[0], max_per_speaker=args.max_embeddings,
        )
    print(f"Enrolled '{args.name}' from {os.path.basename(args.audio)} ({diar.speech_sec[0]:.0f}s of speech).")
    return 0


def cmd_list(args) -> int:
    with VoiceStore(args.db) as store:
        rows = store.list_speakers()
    if args.json:
        json.dump(rows, sys.stdout, indent=2)
        print()
        return 0
    if not rows:
        print("No speakers enrolled yet.")
        return 0
    width = max(len(r["name"]) for r in rows)
    print(f"{'NAME'.ljust(width)}  EMBEDDINGS  MANUAL  PLACEHOLDER")
    for r in rows:
        print(f"{r['name'].ljust(width)}  {r['embeddings']:>10}  {r['manual']:>6}  {'yes' if r['placeholder'] else ''}")
    return 0


def cmd_rename(args) -> int:
    with VoiceStore(args.db) as store:
        store.rename(args.old, args.new)
    print(f"Renamed '{args.old}' to '{args.new}'.")
    return 0


def cmd_merge(args) -> int:
    with VoiceStore(args.db) as store:
        moved = store.merge(args.src, args.dst, max_per_speaker=args.max_embeddings)
    print(f"Merged '{args.src}' into '{args.dst}' ({moved} embeddings moved).")
    return 0


def cmd_forget(args) -> int:
    with VoiceStore(args.db) as store:
        removed = store.forget(args.name)
    print(f"Forgot '{args.name}' ({removed} embeddings deleted).")
    return 0


def cmd_label(args) -> int:
    with open(args.speakers, encoding="utf-8") as fh:
        speakers = json.load(fh)
    with open(args.whisper, encoding="utf-8") as fh:
        whisper = json.load(fh)
    labeled = label_segments(whisper.get("segments", []), speakers.get("turns", []))
    text = to_text(labeled, timestamps=args.timestamps)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    else:
        print(text)
    return 0


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--db", default=DEFAULT_DB, help="voiceprint database (default: %(default)s)")
    common.add_argument("--model", default=DEFAULT_MODEL)
    common.add_argument("--hf-token", default=None)
    common.add_argument("--device", default="cpu", choices=["cpu", "mps", "cuda"])
    common.add_argument("--max-embeddings", type=int, default=20, help="embeddings kept per person")

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("identify", parents=[common], help="name the speakers in a recording")
    p.add_argument("audio")
    p.add_argument("--out", help="write speakers.json here (default: stdout)")
    p.add_argument("--max-speakers", type=int, default=0, help="upper bound for diarization, 0 = automatic")
    p.add_argument("--threshold", type=float, default=0.55)
    p.add_argument("--margin", type=float, default=0.05)
    p.add_argument("--auto-enroll-threshold", type=float, default=0.75)
    p.add_argument("--min-speech-sec", type=float, default=10.0)
    p.add_argument("--no-create-unknown", action="store_true", help="do not create Unknown-NNN profiles")
    p.add_argument("--no-auto-enroll", action="store_true", help="never add embeddings to existing profiles")
    p.add_argument("--dry-run", action="store_true", help="report scores, change nothing in the database")
    p.set_defaults(func=cmd_identify)

    p = sub.add_parser("enroll", parents=[common], help="enroll a person from a clip of only them speaking")
    p.add_argument("name")
    p.add_argument("audio")
    p.add_argument("--min-speech-sec", type=float, default=10.0)
    p.set_defaults(func=cmd_enroll)

    p = sub.add_parser("list", parents=[common], help="list enrolled speakers")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("rename", parents=[common], help="rename a speaker (e.g. Unknown-007)")
    p.add_argument("old")
    p.add_argument("new")
    p.set_defaults(func=cmd_rename)

    p = sub.add_parser("merge", parents=[common], help="merge profile SRC into DST")
    p.add_argument("src")
    p.add_argument("dst")
    p.set_defaults(func=cmd_merge)

    p = sub.add_parser("forget", parents=[common], help="delete a speaker profile")
    p.add_argument("name")
    p.set_defaults(func=cmd_forget)

    p = sub.add_parser("label", help="merge speakers.json turns into a whisper JSON transcript")
    p.add_argument("speakers")
    p.add_argument("whisper")
    p.add_argument("--out")
    p.add_argument("--timestamps", action="store_true")
    p.set_defaults(func=cmd_label)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except StoreError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
