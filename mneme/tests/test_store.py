import numpy as np

from mneme.store import Store


def _vec(*xs):
    return np.array(xs, dtype=np.float32)


def test_save_and_count(tmp_path):
    store = Store(tmp_path / "t.db")
    store.save_asset("/a.jpg", "image", _vec(1, 0, 0), metadata={"brand": "brand-a"})
    store.save_asset("/b.jpg", "image", _vec(0, 1, 0))
    assert store.count() == 2


def test_search_orders_by_cosine(tmp_path):
    store = Store(tmp_path / "t.db")
    store.save_asset("/close.jpg", "image", _vec(1, 0, 0))
    store.save_asset("/mid.jpg", "image", _vec(1, 1, 0))
    store.save_asset("/far.jpg", "image", _vec(0, 0, 1))

    results = store.search(_vec(1, 0, 0), top_k=3, min_score=0.0)
    assert [r.path for r in results] == ["/close.jpg", "/mid.jpg", "/far.jpg"]
    assert results[0].score > results[1].score > results[2].score


def test_min_score_filter(tmp_path):
    store = Store(tmp_path / "t.db")
    store.save_asset("/close.jpg", "image", _vec(1, 0, 0))
    store.save_asset("/orth.jpg", "image", _vec(0, 1, 0))
    results = store.search(_vec(1, 0, 0), top_k=10, min_score=0.5)
    assert [r.path for r in results] == ["/close.jpg"]


def test_type_filter(tmp_path):
    store = Store(tmp_path / "t.db")
    store.save_asset("/a.jpg", "image", _vec(1, 0, 0))
    store.save_asset("/b.txt", "document", _vec(1, 0, 0))
    results = store.search(_vec(1, 0, 0), top_k=10, min_score=0.0, type_filter="document")
    assert len(results) == 1 and results[0].type == "document"


def test_get_by_id_roundtrip(tmp_path):
    store = Store(tmp_path / "t.db")
    aid = store.save_asset("/a.jpg", "image", _vec(1, 0, 0), metadata={"brand": "brand-a"})
    rec = store.get_by_id(aid)
    assert rec is not None and rec.path == "/a.jpg" and rec.metadata["brand"] == "brand-a"
    assert store.get_by_id(99999) is None


def test_dim_mismatch_skipped(tmp_path):
    store = Store(tmp_path / "t.db")
    store.save_asset("/a.jpg", "image", _vec(1, 0, 0))
    # Querying with a different dimension must not crash; it yields no hits.
    assert store.search(_vec(1, 0, 0, 0), top_k=5, min_score=0.0) == []
