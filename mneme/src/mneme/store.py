"""SQLite-backed vector + metadata store.

Schema mirrors the polymathes ``AssetRecord`` so a database produced here is
conceptually interchangeable with the native engine's. Similarity is plain
cosine over float32 vectors; for large libraries the native FAISS/TensorRT path
is the scale story, but pure-numpy is plenty for the adoption tier.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

_SCHEMA = """
CREATE TABLE IF NOT EXISTS assets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    path       TEXT NOT NULL,
    type       TEXT NOT NULL,
    timestamp  REAL NOT NULL DEFAULT 0,
    dim        INTEGER NOT NULL,
    embedding  BLOB NOT NULL,
    metadata   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_assets_path ON assets(path);
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
"""


@dataclass
class SearchResult:
    id: int
    path: str
    type: str
    timestamp: float
    score: float
    metadata: dict


class Store:
    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # -- writes -----------------------------------------------------------
    def has_path(self, path: str) -> bool:
        cur = self._conn.execute("SELECT 1 FROM assets WHERE path = ? LIMIT 1", (path,))
        return cur.fetchone() is not None

    def delete_path(self, path: str) -> None:
        self._conn.execute("DELETE FROM assets WHERE path = ?", (path,))
        self._conn.commit()

    def save_asset(self, path: str, type_: str, embedding: np.ndarray,
                   timestamp: float = 0.0, metadata: Optional[dict] = None) -> int:
        vec = np.asarray(embedding, dtype=np.float32).ravel()
        cur = self._conn.execute(
            "INSERT INTO assets (path, type, timestamp, dim, embedding, metadata) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (path, type_, float(timestamp), int(vec.size), vec.tobytes(),
             json.dumps(metadata or {})),
        )
        self._conn.commit()
        return int(cur.lastrowid)

    # -- reads ------------------------------------------------------------
    def count(self) -> int:
        return int(self._conn.execute("SELECT COUNT(*) FROM assets").fetchone()[0])

    def get_by_id(self, asset_id: int) -> Optional[SearchResult]:
        row = self._conn.execute(
            "SELECT id, path, type, timestamp, metadata FROM assets WHERE id = ?",
            (asset_id,),
        ).fetchone()
        if row is None:
            return None
        return SearchResult(
            id=row["id"], path=row["path"], type=row["type"],
            timestamp=row["timestamp"], score=1.0,
            metadata=json.loads(row["metadata"] or "{}"),
        )

    def search(self, query_vec: np.ndarray, top_k: int = 10, min_score: float = 0.25,
               type_filter: Optional[str] = None) -> list[SearchResult]:
        q = np.asarray(query_vec, dtype=np.float32).ravel()
        qn = float(np.linalg.norm(q))
        if qn == 0.0:
            return []
        q = q / qn

        sql = "SELECT id, path, type, timestamp, dim, embedding, metadata FROM assets"
        params: tuple = ()
        if type_filter:
            sql += " WHERE type = ?"
            params = (type_filter,)

        results: list[SearchResult] = []
        for row in self._conn.execute(sql, params):
            if row["dim"] != q.size:
                continue  # different embedding space; skip rather than crash
            vec = np.frombuffer(row["embedding"], dtype=np.float32)
            vn = float(np.linalg.norm(vec))
            if vn == 0.0:
                continue
            score = float(np.dot(q, vec / vn))
            if score < min_score:
                continue
            results.append(SearchResult(
                id=row["id"], path=row["path"], type=row["type"],
                timestamp=row["timestamp"], score=score,
                metadata=json.loads(row["metadata"] or "{}"),
            ))

        results.sort(key=lambda r: r.score, reverse=True)
        return results[:top_k]
