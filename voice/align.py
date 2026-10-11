"""Merge speaker turns (from speakers.json) with timestamped transcript segments.

Works with the JSON that mlx-whisper / openai-whisper write: a top-level
"segments" list whose items have "start", "end" and "text".
"""
from __future__ import annotations

from typing import Dict, List

UNKNOWN = "Unknown"


def label_segments(segments: List[dict], turns: List[dict], max_gap: float = 1.0) -> List[dict]:
    """Give each segment the name of the turn it overlaps most.

    A segment that overlaps no turn takes the nearest turn within `max_gap`
    seconds, otherwise "Unknown".
    """
    ordered = sorted(turns, key=lambda t: t["start"])
    labeled: List[dict] = []
    for seg in segments:
        s, e = float(seg["start"]), float(seg["end"])
        overlap: Dict[str, float] = {}
        for t in ordered:
            if t["end"] <= s:
                continue
            if t["start"] >= e:
                break
            amount = min(e, t["end"]) - max(s, t["start"])
            if amount > 0:
                overlap[t["name"]] = overlap.get(t["name"], 0.0) + amount
        if overlap:
            name = max(overlap, key=lambda n: overlap[n])
        else:
            name, best = UNKNOWN, max_gap
            for t in ordered:
                gap = max(t["start"] - e, s - t["end"], 0.0)
                if gap <= best:
                    name, best = t["name"], gap
        labeled.append({"start": s, "end": e, "text": str(seg.get("text", "")).strip(), "speaker": name})
    return labeled


def _stamp(seconds: float) -> str:
    total = int(seconds)
    return "%02d:%02d:%02d" % (total // 3600, (total % 3600) // 60, total % 60)


def to_text(labeled: List[dict], timestamps: bool = False) -> str:
    """One paragraph per run of consecutive segments by the same speaker."""
    lines: List[str] = []
    current = None
    buffer: List[str] = []
    start = 0.0

    def flush() -> None:
        if current is None or not buffer:
            return
        prefix = f"[{_stamp(start)}] " if timestamps else ""
        lines.append(f"{prefix}{current}: {' '.join(buffer)}")

    for seg in labeled:
        if not seg["text"]:
            continue
        if seg["speaker"] != current:
            flush()
            current, buffer, start = seg["speaker"], [], seg["start"]
        buffer.append(seg["text"])
    flush()
    return "\n\n".join(lines)
