from mneme.pathmeta import build_metadata, classify_intent, infer_brand, infer_workspace_root


def test_infer_brand_from_content_root():
    assert infer_brand("/D/MyContent/content/skating/reels/clip.mp4") == "skating"
    assert infer_brand("D:\\MyContent\\content\\music\\photos\\x.jpg") == "music"


def test_infer_brand_none_when_no_root():
    assert infer_brand("/random/path/to/file.jpg") is None


def test_workspace_root():
    assert infer_workspace_root("/x/input/brand-a/raw/a.mp4") == "input"
    assert infer_workspace_root("/x/archive/brand-a/p.jpg") == "archive"


def test_classify_intent_folder_hint_wins():
    assert classify_intent("/x/content/brand-a/reels/a.mp4") == "reel"
    assert classify_intent("/x/content/brand-a/thumbnails/a.png") == "thumbnail"


def test_classify_intent_aspect_ratio_fallback():
    assert classify_intent("/x/loose/a.jpg", width=1080, height=1920) == "reel"
    assert classify_intent("/x/loose/a.jpg", width=1080, height=1080) == "post"
    assert classify_intent("/x/loose/a.jpg", width=1920, height=1080) == "thumbnail"


def test_build_metadata_marks_finished_content():
    meta = build_metadata("/x/content/skating/reels/clip.mp4", 1080, 1920)
    assert meta["brand"] == "skating"
    assert meta["workspace"] == "content"
    assert meta["intent"] == "reel"
    assert meta["is_reel"] is True
    assert meta["warn_on_edit"] is True


def test_build_metadata_input_not_warned():
    meta = build_metadata("/x/input/skating/raw/clip.mp4")
    assert meta["warn_on_edit"] is False
