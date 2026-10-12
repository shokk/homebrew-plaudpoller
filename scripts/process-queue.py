#!/usr/bin/env python3
"""Run voice identification over audio files listed in a queue.json.

queue.json (from the Drive `Plaud/` folder) lists recordings by Plaud id. This script does NOT
download anything: put each recording's audio in the inbox folder named <id>.<ext>
(for example of_f88dcb89....mp3 or .ogg), then run:

  scripts/process-queue.py --queue queue.json --inbox ~/plaud-inbox

For every queued recording that has audio in the inbox and is not yet in the local state file,
it runs `plaudpoller voices identify <audio> --out <inbox>/<id>.speakers.json`, then records the
id in <inbox>/.processed.json. Re-running skips finished recordings. Items marked "skip" in the
queue (tiny clips, Plaud samples) are ignored unless --include-skipped is given.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

AUDIO_EXT = (".mp3", ".ogg", ".m4a", ".wav", ".opus")


def find_audio(inbox, rec_id):
    for ext in AUDIO_EXT:
        path = os.path.join(inbox, rec_id + ext)
        if os.path.isfile(path) and os.path.getsize(path) > 0:
            return path
    return None


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default


def save_json(path, payload):
    # write-via-tmp-rename, same pattern as the poller's .state.json
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    os.replace(tmp, path)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--queue", required=True, help="path to queue.json")
    p.add_argument("--inbox", required=True, help="folder holding <id>.<ext> audio files")
    p.add_argument("--cmd", default="plaudpoller", help="plaudpoller executable (default: plaudpoller)")
    p.add_argument("--include-skipped", action="store_true", help="also process items marked skip")
    p.add_argument("--dry-run", action="store_true", help="pass --dry-run to identify (no database changes)")
    args = p.parse_args(argv)

    queue = load_json(args.queue, None)
    if not queue or "recordings" not in queue:
        print(f"error: {args.queue} is not a queue.json", file=sys.stderr)
        return 2
    state_path = os.path.join(args.inbox, ".processed.json")
    state = load_json(state_path, {"processed": {}})
    done = state.setdefault("processed", {})

    todo = missing = skipped = 0
    failures = []
    for rec in queue["recordings"]:
        rid = rec["id"]
        if rid in done:
            continue
        if rec.get("skip") and not args.include_skipped:
            skipped += 1
            continue
        audio = find_audio(args.inbox, rid)
        if not audio:
            missing += 1
            continue
        todo += 1
        out = os.path.join(args.inbox, rid + ".speakers.json")
        cmd = [args.cmd, "voices", "identify", audio, "--out", out]
        if args.dry_run:
            cmd.append("--dry-run")
        print(f"identify {rid} ({rec.get('name', '')[:60]})", flush=True)
        result = subprocess.run(cmd)
        if result.returncode != 0:
            failures.append(rid)
            print(f"  failed (exit {result.returncode}); will retry next run", file=sys.stderr)
            continue
        if not args.dry_run:
            done[rid] = {"audio": os.path.basename(audio), "speakers": os.path.basename(out)}
            save_json(state_path, state)

    print(f"done: {todo - len(failures)} identified, {len(failures)} failed, "
          f"{missing} waiting for audio, {skipped} skipped, {len(done)} processed in total")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
