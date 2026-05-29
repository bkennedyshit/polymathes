"""
Export CLIP ViT-L-14-336 to ONNX using PyTorch 2.7's dynamo exporter.

This replaces the torchscript path in export_model.py which fails on
`aten::_native_multi_head_attention` in PyTorch 2.6+. The dynamo
exporter decomposes all fused ops before lowering to ONNX so the
MHA issue never surfaces.

Output files (same paths the C++ binary expects):
  models/image_encoder.onnx   -- visual encoder
  models/text_encoder.onnx    -- text encoder
  models/tokenizer/           -- BPE vocab + merges

Usage:
  python tools/export_dynamo.py
"""

import os
import sys
import json
import shutil
from pathlib import Path

import torch
import open_clip
import numpy as np

# ── Config ────────────────────────────────────────────────────────────────────
MODEL_NAME   = "ViT-L-14-336"
PRETRAINED   = "openai"
IMAGE_SIZE   = 336
EMBED_DIM    = 768
CTX_LEN      = 77
OUTPUT_DIR   = Path("../models")
OPSET        = 18   # ORT 1.26 supports up to opset 21; 18 is safe + stable

# ── Load ──────────────────────────────────────────────────────────────────────
print(f"Loading {MODEL_NAME} ({PRETRAINED})…")
model, _, preprocess = open_clip.create_model_and_transforms(
    MODEL_NAME, pretrained=PRETRAINED
)
model.eval()
print("Loaded.\n")

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Visual encoder ────────────────────────────────────────────────────────────
print("Exporting visual encoder (dynamo)…")

class VisualWrapper(torch.nn.Module):
    def __init__(self, visual):
        super().__init__()
        self.visual = visual
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.visual(x)

vis = VisualWrapper(model.visual)
vis.eval()

dummy_img = torch.randn(1, 3, IMAGE_SIZE, IMAGE_SIZE)

vis_out = OUTPUT_DIR / "image_encoder.onnx"
with torch.no_grad():
    ep = torch.onnx.export(
        vis,
        (dummy_img,),
        str(vis_out),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=OPSET,
        dynamo=True,
        # No fallback — if dynamo can't trace it we want to know immediately
        # rather than silently re-running the broken torchscript path.
    )
print(f"✓ image_encoder.onnx  ({vis_out.stat().st_size // 1024 // 1024} MB)\n")

# ── Text encoder ──────────────────────────────────────────────────────────────
print("Exporting text encoder (dynamo)…")

class TextWrapper(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m
    def forward(self, tokens: torch.Tensor) -> torch.Tensor:
        return self.m.encode_text(tokens.long(), normalize=False)

txt = TextWrapper(model)
txt.eval()

dummy_tok = torch.randint(0, 49408, (1, CTX_LEN))

txt_out = OUTPUT_DIR / "text_encoder.onnx"
with torch.no_grad():
    torch.onnx.export(
        txt,
        (dummy_tok,),
        str(txt_out),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=OPSET,
        dynamo=True,
    )
print(f"✓ text_encoder.onnx  ({txt_out.stat().st_size // 1024 // 1024} MB)\n")

# ── Tokenizer ─────────────────────────────────────────────────────────────────
print("Exporting tokenizer…")
tok_dir = OUTPUT_DIR / "tokenizer"
tok_dir.mkdir(exist_ok=True)

tokenizer = open_clip.get_tokenizer(MODEL_NAME)

# open_clip tokenizer wraps HuggingFace or its own BPE; try both paths.
try:
    # HuggingFace-backed tokenizer
    hf_tok = tokenizer.tokenizer
    vocab = hf_tok.get_vocab()
    with open(tok_dir / "vocab.json", "w", encoding="utf-8") as f:
        json.dump(vocab, f, ensure_ascii=False, indent=2)
    # merges
    merges_src = getattr(hf_tok, "merges_file", None) or getattr(
        hf_tok, "_tokenizer", None
    )
    if hasattr(hf_tok, "bpe_ranks"):
        merges = [f"{a} {b}" for (a, b) in hf_tok.bpe_ranks.keys()]
        with open(tok_dir / "merges.txt", "w", encoding="utf-8") as f:
            f.write("\n".join(merges))
    print("  (HuggingFace tokenizer path)")
except AttributeError:
    # open_clip's own SimpleTokenizer
    try:
        st = tokenizer._tokenizer if hasattr(tokenizer, "_tokenizer") else tokenizer
        vocab = st.encoder
        with open(tok_dir / "vocab.json", "w", encoding="utf-8") as f:
            json.dump(vocab, f, ensure_ascii=False, indent=2)
        merges = [f"{a} {b}" for (a, b) in st.bpe_ranks.keys()]
        with open(tok_dir / "merges.txt", "w", encoding="utf-8") as f:
            f.write("\n".join(merges))
        print("  (SimpleTokenizer path)")
    except Exception as e:
        print(f"  WARN: tokenizer export partial: {e}")

# ── Config ────────────────────────────────────────────────────────────────────
cfg = {
    "model_name": "openclip-vit-l14-336",
    "image_size": IMAGE_SIZE,
    "embed_dim": EMBED_DIM,
    "context_length": CTX_LEN,
    "opset_version": OPSET,
    "image_encoder": "image_encoder.onnx",
    "text_encoder": "text_encoder.onnx",
    "tokenizer_dir": "tokenizer",
}
with open(OUTPUT_DIR / "model_config.json", "w") as f:
    json.dump(cfg, f, indent=2)

print("\n✓ All done.")
print(f"  Output: {OUTPUT_DIR.resolve()}")
print("  Files:")
for p in sorted(OUTPUT_DIR.rglob("*")):
    if p.is_file():
        print(f"    {p.relative_to(OUTPUT_DIR)}  ({p.stat().st_size // 1024} KB)")
