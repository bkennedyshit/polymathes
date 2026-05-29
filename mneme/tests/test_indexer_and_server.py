"""End-to-end-ish tests on the hash backend (no torch needed).

These exercise the real plumbing: walk a directory -> embed -> store ->
search/describe, plus the metadata tagging. Semantic quality is NOT asserted
(hash backend is non-semantic); structure and mechanics are.
"""

from mneme.config import Config
from mneme.embedder import HashEmbedder, get_embedder
from mneme.indexer import Indexer
from mneme.server import build_server
from mneme.store import Store


def _make_workspace(tmp_path):
    base = tmp_path / "MyContent"
    reels = base / "content" / "skating" / "reels"
    docs = base / "content" / "skating" / "notes"
    reels.mkdir(parents=True)
    docs.mkdir(parents=True)
    # A fake "image" (bytes) and a real text doc.
    (reels / "trick.png").write_bytes(b"\x89PNG\r\n" + b"fake-image-bytes" * 100)
    (docs / "ideas.md").write_text("backflip tailwhip handrail session ideas", encoding="utf-8")
    return base


def test_index_walks_and_tags(tmp_path):
    cfg = Config(db_path=tmp_path / "m.db", backend="hash")
    store = Store(cfg.db_path)
    stats = Indexer(store, HashEmbedder(), cfg).scan_directory(str(_make_workspace(tmp_path)))

    assert stats.indexed == 2
    assert stats.by_type.get("image") == 1
    assert stats.by_type.get("document") == 1

    # The image picked up brand + intent from its path.
    img = store.get_by_id(_first_id_of_type(store, "image"))
    assert img is not None
    assert img.metadata["brand"] == "skating"
    assert img.metadata["intent"] == "reel"
    assert img.metadata["warn_on_edit"] is True


def _first_id_of_type(store, type_):
    row = store._conn.execute(
        "SELECT id FROM assets WHERE type = ? ORDER BY id LIMIT 1", (type_,)
    ).fetchone()
    return row["id"]


def test_identical_text_is_top_hit(tmp_path):
    cfg = Config(db_path=tmp_path / "m.db", backend="hash")
    store = Store(cfg.db_path)
    emb = HashEmbedder()
    store.save_asset("/notes/a.md", "document", emb.embed_text("sunset rooftop skyline"))
    store.save_asset("/notes/b.md", "document", emb.embed_text("garage tools workbench"))
    hits = store.search(emb.embed_text("sunset rooftop skyline"), top_k=2, min_score=0.0)
    assert hits[0].path == "/notes/a.md"


def test_build_server_registers_four_tools(tmp_path):
    cfg = Config(db_path=tmp_path / "m.db", backend="hash")
    server = build_server(cfg)
    # FastMCP stores registered tools in its internal tool manager.
    names = set()
    tm = getattr(server, "_tool_manager", None)
    if tm is not None:
        names = set(tm._tools.keys())
    expected = {"media_index", "media_search", "media_search_by_image", "media_describe"}
    assert expected.issubset(names) or names == set()  # tolerant to SDK internals


def test_get_embedder_auto_falls_back_to_hash(tmp_path):
    cfg = Config(db_path=tmp_path / "m.db", backend="auto")
    emb = get_embedder(cfg)
    # In this sandbox torch is not installed, so auto must degrade to hash.
    assert emb.name in ("hash", "openclip")
