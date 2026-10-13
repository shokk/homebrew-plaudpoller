"""SQLite voiceprint store.

One row per person in `speakers`, many embeddings per person in `embeddings`.
Vectors are stored L2-normalised as float32 BLOBs, so cosine similarity is a
plain dot product. At the scale this is built for (thousands of people, tens
of thousands of vectors) an exact brute-force search over the whole table is
a single matrix multiply, so there is no vector index.
"""
from __future__ import annotations

import os
import re
import sqlite3
import time
from typing import Dict, List, Optional, Tuple

import numpy as np

PLACEHOLDER_RE = re.compile(r"^Unknown-(\d+)$", re.IGNORECASE)

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS speakers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  placeholder INTEGER NOT NULL DEFAULT 0,
  created_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS embeddings (
  id         INTEGER PRIMARY KEY,
  speaker_id INTEGER NOT NULL REFERENCES speakers(id) ON DELETE CASCADE,
  vector     BLOB NOT NULL,
  source     TEXT NOT NULL DEFAULT '',
  manual     INTEGER NOT NULL DEFAULT 0,
  speech_sec REAL NOT NULL DEFAULT 0,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embeddings_speaker ON embeddings(speaker_id);
"""


class StoreError(Exception):
    """A user-facing problem with the voiceprint store."""


def unit_vector(vec) -> np.ndarray:
    v = np.asarray(vec, dtype=np.float32).ravel()
    norm = float(np.linalg.norm(v))
    if not np.isfinite(norm) or norm == 0.0:
        raise StoreError("embedding is all zeros or not finite")
    return (v / norm).astype(np.float32)


class VoiceStore:
    def __init__(self, path: str):
        self.path = path
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.conn = sqlite3.connect(path, timeout=30)
        self.conn.execute("PRAGMA foreign_keys = ON")
        if path != ":memory:":
            self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "VoiceStore":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # -- model guard -------------------------------------------------------

    def _meta_get(self, key: str) -> Optional[str]:
        row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def ensure_model(self, model: str, dim: int) -> None:
        """Embeddings from different models are not comparable; refuse to mix them."""
        stored_model = self._meta_get("model")
        stored_dim = self._meta_get("dim")
        count = self.conn.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0]
        if stored_model is not None and count > 0:
            if stored_model != model or int(stored_dim or 0) != dim:
                raise StoreError(
                    f"voice database was built with model '{stored_model}' (dim {stored_dim}); "
                    f"this run uses '{model}' (dim {dim}). Embeddings from different models "
                    f"cannot be compared. Use a new --db, or forget all speakers first."
                )
            return
        with self.conn:
            self.conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('model', ?)", (model,))
            self.conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('dim', ?)", (str(dim),))

    # -- speakers ----------------------------------------------------------

    def speaker_id(self, name: str) -> Optional[int]:
        row = self.conn.execute("SELECT id FROM speakers WHERE name = ?", (name.strip(),)).fetchone()
        return row[0] if row else None

    def add_speaker(self, name: str, placeholder: bool = False) -> int:
        name = name.strip()
        if not name:
            raise StoreError("speaker name is empty")
        try:
            with self.conn:
                cur = self.conn.execute(
                    "INSERT INTO speakers(name, placeholder, created_at) VALUES (?, ?, ?)",
                    (name, 1 if placeholder else 0, time.time()),
                )
        except sqlite3.IntegrityError:
            raise StoreError(f"speaker already exists: {name}")
        return int(cur.lastrowid)

    def get_or_add_speaker(self, name: str) -> int:
        existing = self.speaker_id(name)
        return existing if existing is not None else self.add_speaker(name)

    def next_placeholder_name(self) -> str:
        rows = self.conn.execute("SELECT name FROM speakers WHERE name LIKE 'Unknown-%'").fetchall()
        numbers = []
        for (name,) in rows:
            m = PLACEHOLDER_RE.match(name)
            if m:
                numbers.append(int(m.group(1)))
        return "Unknown-%03d" % (max(numbers, default=0) + 1)

    def names(self) -> Dict[int, str]:
        return {int(i): n for i, n in self.conn.execute("SELECT id, name FROM speakers")}

    def list_speakers(self) -> List[dict]:
        rows = self.conn.execute(
            """
            SELECT s.name, s.placeholder, COUNT(e.id), COALESCE(SUM(e.manual), 0), MAX(e.created_at)
            FROM speakers s LEFT JOIN embeddings e ON e.speaker_id = s.id
            GROUP BY s.id
            ORDER BY s.placeholder, s.name COLLATE NOCASE
            """
        ).fetchall()
        return [
            {
                "name": name,
                "placeholder": bool(placeholder),
                "embeddings": int(count),
                "manual": int(manual),
                "lastAdded": last,
            }
            for name, placeholder, count, manual, last in rows
        ]

    def rename(self, old: str, new: str) -> None:
        old_id = self.speaker_id(old)
        if old_id is None:
            raise StoreError(f"no such speaker: {old}")
        new = new.strip()
        if not new:
            raise StoreError("new name is empty")
        clash = self.speaker_id(new)
        if clash is not None and clash != old_id:
            raise StoreError(f"'{new}' already exists; use merge to combine '{old}' into it")
        still_placeholder = 1 if PLACEHOLDER_RE.match(new) else 0
        with self.conn:
            self.conn.execute(
                "UPDATE speakers SET name = ?, placeholder = ? WHERE id = ?", (new, still_placeholder, old_id)
            )

    def merge(self, src: str, dst: str, max_per_speaker: int = 0) -> int:
        src_id, dst_id = self.speaker_id(src), self.speaker_id(dst)
        if src_id is None:
            raise StoreError(f"no such speaker: {src}")
        if dst_id is None:
            raise StoreError(f"no such speaker: {dst}")
        if src_id == dst_id:
            raise StoreError("cannot merge a speaker into itself")
        with self.conn:
            cur = self.conn.execute("UPDATE embeddings SET speaker_id = ? WHERE speaker_id = ?", (dst_id, src_id))
            moved = cur.rowcount
            self.conn.execute("DELETE FROM speakers WHERE id = ?", (src_id,))
            self._evict(dst_id, max_per_speaker)
        return int(moved)

    def forget(self, name: str) -> int:
        sid = self.speaker_id(name)
        if sid is None:
            raise StoreError(f"no such speaker: {name}")
        count = self.conn.execute("SELECT COUNT(*) FROM embeddings WHERE speaker_id = ?", (sid,)).fetchone()[0]
        with self.conn:
            self.conn.execute("DELETE FROM speakers WHERE id = ?", (sid,))
        return int(count)

    # -- embeddings --------------------------------------------------------

    def add_embedding(
        self,
        speaker_id: int,
        vec,
        source: str = "",
        manual: bool = False,
        speech_sec: float = 0.0,
        max_per_speaker: int = 20,
    ) -> int:
        v = unit_vector(vec)
        with self.conn:
            cur = self.conn.execute(
                "INSERT INTO embeddings(speaker_id, vector, source, manual, speech_sec, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (speaker_id, v.tobytes(), source, 1 if manual else 0, float(speech_sec), time.time()),
            )
            self._evict(speaker_id, max_per_speaker)
        return int(cur.lastrowid)

    def has_embedding_from(self, speaker_id: int, source: str) -> bool:
        """True if this person already has an embedding taken from `source` (a recording)."""
        if not source:
            return False
        row = self.conn.execute(
            "SELECT 1 FROM embeddings WHERE speaker_id = ? AND source = ? LIMIT 1", (speaker_id, source)
        ).fetchone()
        return row is not None

    def _evict(self, speaker_id: int, cap: int) -> None:
        """Keep at most `cap` embeddings per person, dropping the oldest automatic ones.

        Manually enrolled embeddings are never evicted.
        """
        if cap <= 0:
            return
        count = self.conn.execute("SELECT COUNT(*) FROM embeddings WHERE speaker_id = ?", (speaker_id,)).fetchone()[0]
        excess = count - cap
        if excess <= 0:
            return
        victims = self.conn.execute(
            "SELECT id FROM embeddings WHERE speaker_id = ? AND manual = 0 ORDER BY created_at, id LIMIT ?",
            (speaker_id, excess),
        ).fetchall()
        self.conn.executemany("DELETE FROM embeddings WHERE id = ?", victims)

    def load_matrix(self) -> Tuple[np.ndarray, np.ndarray]:
        """Return (speaker_id per row, unit-norm embedding matrix)."""
        rows = self.conn.execute("SELECT speaker_id, vector FROM embeddings ORDER BY id").fetchall()
        if not rows:
            return np.empty(0, dtype=np.int64), np.empty((0, 0), dtype=np.float32)
        ids = np.array([r[0] for r in rows], dtype=np.int64)
        matrix = np.stack([np.frombuffer(r[1], dtype=np.float32) for r in rows])
        return ids, matrix
