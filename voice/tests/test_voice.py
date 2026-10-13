"""Unit tests for the voice sidecar. Synthetic embeddings only: no pyannote, torch or audio needed.

Run:  python3 -m unittest discover -s voice/tests -v
"""
import json
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from align import label_segments, to_text  # noqa: E402
from identify import Diarization, Options, process  # noqa: E402
from matching import MatchConfig, Match, match_speakers, should_auto_enroll  # noqa: E402
from store import StoreError, VoiceStore  # noqa: E402

D = 64


def unit(v):
    v = np.asarray(v, dtype=np.float32)
    return v / np.linalg.norm(v)


def voice(seed):
    return unit(np.random.default_rng(seed).normal(size=D))


def noisy(v, seed, amount):
    """v plus an independent random direction of length `amount` (cosine to v is about 1/sqrt(1+amount^2))."""
    n = np.random.default_rng(1000 + seed).normal(size=D)
    n = n / np.linalg.norm(n)
    return unit(v + amount * n)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.store = VoiceStore(":memory:")

    def test_embeddings_are_normalised_on_the_way_in(self):
        sid = self.store.add_speaker("Alice")
        self.store.add_embedding(sid, voice(1) * 5.0)
        ids, matrix = self.store.load_matrix()
        self.assertEqual(ids.tolist(), [sid])
        self.assertAlmostEqual(float(np.linalg.norm(matrix[0])), 1.0, places=5)

    def test_zero_vector_rejected(self):
        sid = self.store.add_speaker("Alice")
        with self.assertRaises(StoreError):
            self.store.add_embedding(sid, np.zeros(D))

    def test_eviction_drops_oldest_automatic_and_never_manual(self):
        sid = self.store.add_speaker("Alice")
        self.store.add_embedding(sid, voice(1), manual=True, max_per_speaker=3)
        self.store.add_embedding(sid, voice(2), manual=True, max_per_speaker=3)
        for seed in (3, 4, 5):
            self.store.add_embedding(sid, voice(seed), max_per_speaker=3)
        info = self.store.list_speakers()[0]
        self.assertEqual(info["embeddings"], 3)
        self.assertEqual(info["manual"], 2)

    def test_placeholder_numbering_and_rename(self):
        a = self.store.next_placeholder_name()
        self.assertEqual(a, "Unknown-001")
        self.store.add_speaker(a, placeholder=True)
        b = self.store.next_placeholder_name()
        self.assertEqual(b, "Unknown-002")
        self.store.add_speaker(b, placeholder=True)
        self.store.rename("Unknown-001", "Bob")
        self.assertEqual(self.store.next_placeholder_name(), "Unknown-003")
        bob = [s for s in self.store.list_speakers() if s["name"] == "Bob"][0]
        self.assertFalse(bob["placeholder"])

    def test_rename_onto_existing_name_points_at_merge(self):
        self.store.add_speaker("Alice")
        self.store.add_speaker("Bob")
        with self.assertRaisesRegex(StoreError, "merge"):
            self.store.rename("Alice", "bob")

    def test_merge_moves_embeddings_and_removes_source(self):
        a = self.store.add_speaker("Unknown-001", placeholder=True)
        b = self.store.add_speaker("Alice")
        self.store.add_embedding(a, voice(1))
        self.store.add_embedding(b, voice(2))
        moved = self.store.merge("Unknown-001", "Alice")
        self.assertEqual(moved, 1)
        self.assertIsNone(self.store.speaker_id("Unknown-001"))
        self.assertEqual(self.store.list_speakers()[0]["embeddings"], 2)

    def test_forget_cascades(self):
        sid = self.store.add_speaker("Alice")
        self.store.add_embedding(sid, voice(1))
        self.assertEqual(self.store.forget("Alice"), 1)
        ids, _ = self.store.load_matrix()
        self.assertEqual(len(ids), 0)

    def test_model_guard(self):
        self.store.ensure_model("m", D)
        sid = self.store.add_speaker("Alice")
        self.store.add_embedding(sid, voice(1))
        self.store.ensure_model("m", D)  # same model is fine
        with self.assertRaises(StoreError):
            self.store.ensure_model("other", D)
        with self.assertRaises(StoreError):
            self.store.ensure_model("m", D + 1)

    def test_model_can_change_while_database_is_empty(self):
        self.store.ensure_model("m", D)
        self.store.ensure_model("other", 128)  # no embeddings yet, so nothing to conflict with


class MatchingTests(unittest.TestCase):
    def db(self):
        store = VoiceStore(":memory:")
        self.people = {}
        for i, name in enumerate(["Alice", "Bob", "Cara"]):
            sid = store.add_speaker(name)
            self.people[name] = sid
            base = voice(i + 1)
            store.add_embedding(sid, noisy(base, i, 0.2))
            store.add_embedding(sid, noisy(base, i + 50, 0.2))
        self.bases = {n: voice(i + 1) for i, n in enumerate(["Alice", "Bob", "Cara"])}
        return store.load_matrix()

    def test_known_voice_matches(self):
        ids, matrix = self.db()
        q = np.stack([noisy(self.bases["Bob"], 7, 0.25)])
        [m] = match_speakers(q, ids, matrix, MatchConfig())
        self.assertEqual(m.status, "matched")
        self.assertEqual(m.speaker_id, self.people["Bob"])
        self.assertGreater(m.score, 0.85)

    def test_stranger_is_unknown(self):
        ids, matrix = self.db()
        q = np.stack([voice(999)])
        [m] = match_speakers(q, ids, matrix, MatchConfig())
        self.assertEqual(m.status, "unknown")
        self.assertIsNone(m.speaker_id)

    def test_near_twin_profiles_are_rejected_by_margin(self):
        store = VoiceStore(":memory:")
        base = voice(1)
        a = store.add_speaker("Twin A")
        b = store.add_speaker("Twin B")
        store.add_embedding(a, base)
        store.add_embedding(b, noisy(base, 3, 0.05))
        ids, matrix = store.load_matrix()
        q = np.stack([noisy(base, 4, 0.05)])
        [m] = match_speakers(q, ids, matrix, MatchConfig(threshold=0.55, margin=0.05))
        self.assertEqual(m.status, "unknown")
        self.assertGreater(m.score, 0.9)  # strong score, but ambiguous

    def test_assignment_is_one_to_one_within_a_recording(self):
        ids, matrix = self.db()
        alice = self.bases["Alice"]
        q = np.stack([noisy(alice, 11, 0.1), noisy(alice, 12, 1.0)])  # both look like Alice; row 0 much closer
        results = match_speakers(q, ids, matrix, MatchConfig(threshold=0.55, margin=0.0))
        matched = [r for r in results if r.status == "matched"]
        self.assertEqual(len(matched), 1)
        self.assertEqual(results[0].status, "matched")
        self.assertEqual(results[0].speaker_id, self.people["Alice"])
        self.assertEqual(results[1].status, "unknown")

    def test_sub_threshold_pairs_cannot_displace_a_real_match(self):
        # Row A: X=0.80, Y=0.50. Row B: X=0.45, Y=0.00. Only A->X clears the 0.55 threshold.
        # A plain max-sum assignment would pick A->Y + B->X (0.95 > 0.80) and then lose both.
        store = VoiceStore(":memory:")
        x = store.add_speaker("X")
        y = store.add_speaker("Y")
        store.add_embedding(x, [1.0, 0.0, 0.0])
        store.add_embedding(y, [0.0, 1.0, 0.0])
        ids, matrix = store.load_matrix()
        a = [0.80, 0.50, float(np.sqrt(1 - 0.80**2 - 0.50**2))]
        b = [0.45, 0.00, float(np.sqrt(1 - 0.45**2))]
        results = match_speakers(
            np.stack([unit(a), unit(b)]), ids, matrix, MatchConfig(threshold=0.55, margin=0.0)
        )
        self.assertEqual(results[0].status, "matched")
        self.assertEqual(results[0].speaker_id, x)
        self.assertEqual(results[1].status, "unknown")

    def test_empty_database(self):
        results = match_speakers(
            np.stack([voice(1), voice(2)]), np.empty(0, dtype=np.int64), np.empty((0, 0), dtype=np.float32),
            MatchConfig(),
        )
        self.assertEqual([r.status for r in results], ["unknown", "unknown"])

    def test_dimension_mismatch_raises(self):
        ids, matrix = self.db()
        with self.assertRaises(ValueError):
            match_speakers(np.zeros((1, D + 3), dtype=np.float32), ids, matrix, MatchConfig())

    def test_auto_enroll_needs_strong_and_unambiguous(self):
        cfg = MatchConfig(threshold=0.55, margin=0.05, auto_enroll_threshold=0.75)
        self.assertTrue(should_auto_enroll(Match("matched", 1, 0.9, 0.3, 1), cfg))
        self.assertFalse(should_auto_enroll(Match("matched", 1, 0.7, 0.3, 1), cfg))  # not strong enough
        self.assertFalse(should_auto_enroll(Match("matched", 1, 0.9, 0.04, 1), cfg))  # too close to runner-up
        self.assertFalse(should_auto_enroll(Match("unknown", None, 0.9, 0.3, 1), cfg))


class ProcessTests(unittest.TestCase):
    def diar(self, voices_and_secs, turns=None):
        labels = [f"SPEAKER_{i:02d}" for i in range(len(voices_and_secs))]
        return Diarization(
            labels=labels,
            embeddings=np.stack([v for v, _ in voices_and_secs]),
            speech_sec=[s for _, s in voices_and_secs],
            turns=turns or [{"start": 10.0 * i, "end": 10.0 * i + 8, "label": l} for i, l in enumerate(labels)],
        )

    def test_full_lifecycle(self):
        store = VoiceStore(":memory:")
        opts = Options(source="first.mp3", min_speech_sec=10.0)
        a, b = voice(1), voice(2)

        # Recording 1: two real speakers and one with too little speech to trust.
        first = process(self.diar([(a, 30.0), (b, 20.0), (voice(3), 3.0)]), store, "m", opts)
        self.assertEqual([s["status"] for s in first["speakers"]], ["new", "new", "skipped"])
        self.assertEqual([s["name"] for s in first["speakers"]], ["Unknown-001", "Unknown-002", "SPEAKER_02"])
        self.assertEqual(len(store.list_speakers()), 2)  # the skipped speaker was not stored
        json.dumps(first)  # must be serialisable

        store.rename("Unknown-001", "Alice")

        # Recording 2: Alice again (slightly different), plus someone new.
        opts2 = Options(source="second.mp3", min_speech_sec=10.0)
        second = process(self.diar([(noisy(a, 5, 0.2), 40.0), (voice(77), 25.0)]), store, "m", opts2)
        self.assertEqual(second["speakers"][0]["name"], "Alice")
        self.assertEqual(second["speakers"][0]["status"], "matched")
        self.assertTrue(second["speakers"][0]["enrolled"])  # confident match grows her profile
        self.assertEqual(second["speakers"][1]["status"], "new")
        self.assertEqual(second["speakers"][1]["name"], "Unknown-003")
        self.assertEqual([t["name"] for t in second["turns"]], ["Alice", "Unknown-003"])
        alice = [s for s in store.list_speakers() if s["name"] == "Alice"][0]
        self.assertEqual(alice["embeddings"], 2)

    def test_rerunning_the_same_recording_does_not_inflate_profiles(self):
        store = VoiceStore(":memory:")
        opts = Options(source="meeting.mp3")
        d = self.diar([(voice(1), 30.0)])
        process(d, store, "m", opts)  # creates Unknown-001 with one embedding from meeting.mp3
        again = process(d, store, "m", opts)  # same file again: matches, but must not enrol a duplicate
        self.assertEqual(again["speakers"][0]["status"], "matched")
        self.assertFalse(again["speakers"][0]["enrolled"])
        self.assertEqual(store.list_speakers()[0]["embeddings"], 1)

    def test_dry_run_changes_nothing(self):
        store = VoiceStore(":memory:")
        result = process(self.diar([(voice(1), 30.0)]), store, "m", Options(dry_run=True))
        self.assertEqual(result["speakers"][0]["status"], "unknown")
        self.assertEqual(store.list_speakers(), [])

    def test_no_create_unknown(self):
        store = VoiceStore(":memory:")
        result = process(self.diar([(voice(1), 30.0)]), store, "m", Options(create_unknown=False))
        self.assertEqual(result["speakers"][0]["status"], "unknown")
        self.assertEqual(store.list_speakers(), [])

    def test_nan_embedding_is_skipped(self):
        store = VoiceStore(":memory:")
        bad = np.full(D, np.nan, dtype=np.float32)
        result = process(self.diar([(bad, 60.0)]), store, "m", Options())
        self.assertEqual(result["speakers"][0]["status"], "skipped")

    def test_no_speakers(self):
        store = VoiceStore(":memory:")
        empty = Diarization(labels=[], embeddings=np.empty((0, 0)), speech_sec=[], turns=[])
        result = process(empty, store, "m", Options())
        self.assertEqual(result["speakers"], [])
        self.assertEqual(result["turns"], [])


class AlignTests(unittest.TestCase):
    turns = [
        {"start": 0.0, "end": 4.0, "name": "Alice"},
        {"start": 4.0, "end": 10.0, "name": "Bob"},
    ]

    def test_segment_takes_speaker_with_most_overlap(self):
        segs = [
            {"start": 0.0, "end": 5.0, "text": " hello "},  # 4s Alice, 1s Bob
            {"start": 6.0, "end": 9.0, "text": "hi there"},
        ]
        labeled = label_segments(segs, self.turns)
        self.assertEqual([s["speaker"] for s in labeled], ["Alice", "Bob"])
        self.assertEqual(labeled[0]["text"], "hello")

    def test_nearby_gap_uses_nearest_turn_and_far_gap_is_unknown(self):
        segs = [
            {"start": 10.5, "end": 12.0, "text": "just after"},
            {"start": 30.0, "end": 31.0, "text": "much later"},
        ]
        labeled = label_segments(segs, self.turns)
        self.assertEqual([s["speaker"] for s in labeled], ["Bob", "Unknown"])

    def test_to_text_merges_consecutive_speakers(self):
        labeled = [
            {"start": 0.0, "end": 2.0, "text": "one", "speaker": "Alice"},
            {"start": 2.0, "end": 3.0, "text": "two", "speaker": "Alice"},
            {"start": 65.0, "end": 66.0, "text": "three", "speaker": "Bob"},
        ]
        self.assertEqual(to_text(labeled), "Alice: one two\n\nBob: three")
        self.assertEqual(to_text(labeled, timestamps=True), "[00:00:00] Alice: one two\n\n[00:01:05] Bob: three")


if __name__ == "__main__":
    unittest.main()
