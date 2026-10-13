"""Match the speakers diarized in ONE recording against the stored voiceprints.

Rules, in order:
  1. A person's score for a speaker is the best cosine similarity over all of
     that person's stored embeddings.
  2. A pairing only counts if the score reaches `threshold`.
  3. Assignment is one-to-one within the recording (Hungarian algorithm): two
     diarized speakers in the same recording can never both be the same
     person.
  4. A pairing is rejected if the assigned person does not lead every other
     person by at least `margin`. This is what keeps false matches down as the
     database grows into the thousands.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

import numpy as np
from scipy.optimize import linear_sum_assignment


@dataclass
class MatchConfig:
    threshold: float = 0.55
    margin: float = 0.05
    auto_enroll_threshold: float = 0.75


@dataclass
class Match:
    status: str  # "matched" | "unknown"
    speaker_id: Optional[int]  # set only when matched
    score: float  # assigned person's score, or the best candidate's score when unknown
    margin: float  # lead over the next-best different person
    candidate_id: Optional[int]  # best-scoring person, even if rejected


def match_speakers(
    embeddings: np.ndarray,
    db_ids: np.ndarray,
    db_matrix: np.ndarray,
    cfg: MatchConfig,
) -> List[Match]:
    """`embeddings` is K x D (unit norm); `db_ids`/`db_matrix` come from VoiceStore.load_matrix()."""
    k = embeddings.shape[0]
    if k == 0:
        return []
    if db_matrix.shape[0] == 0:
        return [Match("unknown", None, 0.0, 0.0, None) for _ in range(k)]
    if embeddings.shape[1] != db_matrix.shape[1]:
        raise ValueError(
            f"embedding size {embeddings.shape[1]} does not match the database ({db_matrix.shape[1]})"
        )

    sims = embeddings @ db_matrix.T  # K x M, cosine because everything is unit norm

    # Collapse M embeddings down to P people: best similarity per person.
    order = np.argsort(db_ids, kind="stable")
    sorted_ids = db_ids[order]
    starts = np.flatnonzero(np.r_[True, sorted_ids[1:] != sorted_ids[:-1]])
    people = sorted_ids[starts]
    scores = np.maximum.reduceat(sims[:, order], starts, axis=1)  # K x P

    # Sub-threshold pairings are worth nothing, so they can never displace a
    # legitimate match when the assignment is solved.
    allowed = scores >= cfg.threshold
    value = np.where(allowed, scores, 0.0)
    rows, cols = linear_sum_assignment(-value)
    assigned = {int(r): int(c) for r, c in zip(rows, cols) if allowed[r, c]}

    results: List[Match] = []
    for i in range(k):
        row = scores[i]
        best_c = int(np.argmax(row))
        if i in assigned:
            c = assigned[i]
            others = np.delete(row, c)
            second = float(others.max()) if others.size else -1.0
            lead = float(row[c]) - second
            if lead >= cfg.margin:
                results.append(Match("matched", int(people[c]), float(row[c]), lead, int(people[best_c])))
                continue
            results.append(Match("unknown", None, float(row[c]), lead, int(people[best_c])))
            continue
        others = np.delete(row, best_c)
        second = float(others.max()) if others.size else -1.0
        results.append(
            Match("unknown", None, float(row[best_c]), float(row[best_c]) - second, int(people[best_c]))
        )
    return results


def should_auto_enroll(m: Match, cfg: MatchConfig) -> bool:
    """Only grow a profile from matches that are both strong and clearly unambiguous."""
    return m.status == "matched" and m.score >= cfg.auto_enroll_threshold and m.margin >= cfg.margin
