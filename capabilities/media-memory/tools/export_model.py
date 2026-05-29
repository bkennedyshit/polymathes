#!/usr/bin/env python3
"""
Export CLIP models to ONNX format for omni-search.

Supports multiple model architectures with automatic configuration.
Exports visual encoder, text encoder, and tokenizer files.
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

import torch
import torch.onnx
import onnx
import onnxruntime as ort
import numpy as np

try:
    import open_clip
except ImportError:
    print("ERROR: open_clip_torch not installed. Run: pip install open_clip_torch")
    sys.exit(1)

# Model configurations: (open_clip_name, pretrained, image_size, embed_dim, context_length)
MODEL_CONFIGS = {
    "clip-vit-b32": ("ViT-B-32", "laion2b_s34b_b79k", 224, 512, 77),
    "clip-vit-l14": ("ViT-L-14", "openai", 224, 768, 77),
    "openclip-vit-l14-336": ("ViT-L-14-336", "openai", 336, 768, 77),
    "siglip-400m": ("ViT-SO400M-14-SigLIP-384", "webli", 384, 1152, 64),
}


class TextEncoderWrapper(torch.nn.Module):
    """Wrapper for CLIP text encoder that accepts raw token tensors."""
    
    def __init__(self, model):
        super().__init__()
        self.model = model
        
    def forward(self, text_tokens):
        """
        Args:
            text_tokens: [batch, context_length] int64 tensor of token IDs
            
        Returns:
            text_embeddings: [batch, embed_dim] float32 tensor
        """
        # Cast to int if needed
        if text_tokens.dtype != torch.long:
            text_tokens = text_tokens.long()
            
        # Encode text
        text_features = self.model.encode_text(text_tokens, normalize=False)
        return text_features


def export_onnx_model(
    model_name: str,
    output_dir: str = "../models",
    validate: bool = False,
    opset_version: int = 17
):
    """Export CLIP model to ONNX format."""
    
    if model_name not in MODEL_CONFIGS:
        print(f"ERROR: Unknown model '{model_name}'")
        print(f"Available models: {', '.join(MODEL_CONFIGS.keys())}")
        sys.exit(1)
    
    open_clip_name, pretrained, image_size, embed_dim, context_length = MODEL_CONFIGS[model_name]
    
    print(f"=== Exporting {model_name} ===")
    print(f"  OpenCLIP model: {open_clip_name}")
    print(f"  Pretrained: {pretrained}")
    print(f"  Image size: {image_size}x{image_size}")
    print(f"  Embedding dim: {embed_dim}")
    print(f"  Context length: {context_length}")
    print()
    
    # Create output directory
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    tokenizer_path = output_path / "tokenizer"
    tokenizer_path.mkdir(exist_ok=True)
    
    # Load model
    print(f"Loading {open_clip_name} with {pretrained} weights...")
    try:
        model, _, preprocess = open_clip.create_model_and_transforms(
            open_clip_name, 
            pretrained=pretrained
        )
    except Exception as e:
        print(f"ERROR: Failed to load model: {e}")
        print("Make sure the model name and pretrained weights are correct.")
        sys.exit(1)
    
    model.eval()

    # PyTorch 2.7's ONNX exporter can't handle the fused
    # `aten::_native_multi_head_attention` op that nn.MultiheadAttention
    # uses by default. Disable BOTH the module-level fastpath flag AND
    # the global `need_weights=True` shortcut by monkey-patching forward
    # to always go through the unfused path. This adds ~5s to export
    # but is required for any post-2.6 PyTorch / opset combo.
    try:
        # Module-level: disable transformer encoder fastpath so the
        # visual encoder doesn't dispatch to _native_multi_head_attention.
        for m in model.modules():
            if isinstance(m, torch.nn.MultiheadAttention):
                m._is_fastpath_enabled = False  # type: ignore[attr-defined]
            # Some open_clip versions wrap a TransformerEncoder; clear
            # its fastpath too.
            if isinstance(m, torch.nn.TransformerEncoder):
                m.enable_nested_tensor = False
            if isinstance(m, torch.nn.TransformerEncoderLayer):
                m._is_fastpath_enabled = False  # type: ignore[attr-defined]

        # Global: monkey-patch nn.MultiheadAttention.forward to use the
        # functional path with need_weights=True (which guarantees the
        # exporter sees the decomposed graph).
        _orig_mha_forward = torch.nn.MultiheadAttention.forward
        def _unfused_mha_forward(self, query, key, value, key_padding_mask=None,
                                 need_weights=True, attn_mask=None,
                                 average_attn_weights=True, is_causal=False):
            return _orig_mha_forward(
                self, query, key, value,
                key_padding_mask=key_padding_mask,
                need_weights=True,  # force decomposed path
                attn_mask=attn_mask,
                average_attn_weights=average_attn_weights,
                is_causal=False,    # avoid causal-fastpath
            )
        torch.nn.MultiheadAttention.forward = _unfused_mha_forward
    except Exception as _e:
        print(f"WARN: MHA fastpath patch failed: {_e}")

    # Belt-and-suspenders: force PyTorch's SDPA backend selection to
    # `math` so any open_clip path that hits scaled_dot_product_attention
    # (rather than nn.MultiheadAttention) still produces an ONNX-exportable
    # decomposition. The flash and mem-efficient backends both lower to
    # the same fused C++ op the exporter chokes on.
    try:
        from torch.nn.attention import SDPBackend, sdpa_kernel
        _sdpa_ctx = sdpa_kernel(SDPBackend.MATH)
        _sdpa_ctx.__enter__()
        print("SDPA forced to math backend for export.")
    except Exception as _e:
        print(f"WARN: could not pin SDPA backend: {_e}")
        _sdpa_ctx = None

    print("Model loaded successfully.\n")
    
    # Export visual encoder
    print("Exporting visual encoder...")
    visual_output = output_path / "clip_visual.onnx"
    
    dummy_image = torch.randn(1, 3, image_size, image_size, dtype=torch.float32)
    
    with torch.no_grad():
        torch.onnx.export(
            model.visual,
            dummy_image,
            str(visual_output),
            input_names=["input"],
            output_names=["output"],
            dynamic_axes={
                "input": {0: "batch_size"},
                "output": {0: "batch_size"}
            },
            opset_version=opset_version,
            do_constant_folding=True,
            # PyTorch 2.7+ — the dynamo exporter handles fused ops the
            # torchscript exporter rejects (`_native_multi_head_attention`
            # being the canonical example for CLIP). `fallback=True`
            # keeps the legacy path as a safety net for op-set quirks.
            dynamo=True,
            fallback=True,
        )
    
    print(f"✓ Visual encoder exported to {visual_output}")
    
    # Export text encoder
    print("Exporting text encoder...")
    text_output = output_path / "clip_text.onnx"
    
    text_wrapper = TextEncoderWrapper(model)
    text_wrapper.eval()
    
    dummy_tokens = torch.randint(0, 49408, (1, context_length), dtype=torch.long)
    
    with torch.no_grad():
        torch.onnx.export(
            text_wrapper,
            dummy_tokens,
            str(text_output),
            input_names=["input"],
            output_names=["output"],
            dynamic_axes={
                "input": {0: "batch_size"},
                "output": {0: "batch_size"}
            },
            opset_version=opset_version,
            do_constant_folding=True,
            # See visual export above for why dynamo=True is required.
            dynamo=True,
            fallback=True,
        )
    
    print(f"✓ Text encoder exported to {text_output}")
    
    # Export tokenizer files
    print("Exporting tokenizer files...")
    tokenizer = open_clip.get_tokenizer(open_clip_name)
    
    # Save vocab and merges
    vocab_file = tokenizer_path / "vocab.json"
    merges_file = tokenizer_path / "merges.txt"
    
    # Extract vocabulary
    if hasattr(tokenizer, 'encoder'):
        vocab = tokenizer.encoder
    elif hasattr(tokenizer, 'vocab'):
        vocab = tokenizer.vocab
    else:
        print("WARNING: Could not extract vocabulary from tokenizer")
        vocab = {}
    
    with open(vocab_file, 'w', encoding='utf-8') as f:
        json.dump(vocab, f, ensure_ascii=False, indent=2)
    
    print(f"✓ Vocabulary exported to {vocab_file}")
    
    # Extract BPE merges
    if hasattr(tokenizer, 'bpe_ranks'):
        merges = list(tokenizer.bpe_ranks.keys())
    elif hasattr(tokenizer, 'merges'):
        merges = tokenizer.merges
    else:
        print("WARNING: Could not extract BPE merges from tokenizer")
        merges = []
    
    with open(merges_file, 'w', encoding='utf-8') as f:
        for merge_tuple in merges:
            if isinstance(merge_tuple, tuple):
                f.write(f"{merge_tuple[0]} {merge_tuple[1]}\n")
            else:
                f.write(f"{merge_tuple}\n")
    
    print(f"✓ BPE merges exported to {merges_file}")
    
    # Save model info
    model_info = {
        "model": model_name,
        "open_clip_name": open_clip_name,
        "pretrained": pretrained,
        "embed_dim": embed_dim,
        "image_size": image_size,
        "context_length": context_length,
        "opset_version": opset_version,
    }
    
    info_file = output_path / "model_info.json"
    with open(info_file, 'w') as f:
        json.dump(model_info, f, indent=2)
    
    print(f"✓ Model info saved to {info_file}\n")
    
    # Validate exported models
    if validate:
        print("=== Validating ONNX models ===")
        validate_export(model, visual_output, text_output, image_size, context_length)
    
    print("\n✓ Export complete!")
    print(f"\nNext steps:")
    print(f"  1. Convert to TensorRT engines for GPU acceleration:")
    print(f"     trtexec --onnx={visual_output} --saveEngine={output_path}/clip_visual.engine --fp16")
    print(f"     trtexec --onnx={text_output} --saveEngine={output_path}/clip_text.engine --fp16")
    print(f"  2. Or use ONNX Runtime directly (CPU/GPU fallback)")


def validate_export(
    pytorch_model,
    visual_onnx_path: Path,
    text_onnx_path: Path,
    image_size: int,
    context_length: int
):
    """Validate that ONNX models produce similar outputs to PyTorch."""
    
    print("Loading ONNX models...")
    
    try:
        # Load ONNX Runtime sessions
        visual_session = ort.InferenceSession(
            str(visual_onnx_path),
            providers=['CPUExecutionProvider']
        )
        text_session = ort.InferenceSession(
            str(text_onnx_path),
            providers=['CPUExecutionProvider']
        )
        
        # Test visual encoder
        print("Testing visual encoder...")
        test_image = torch.randn(1, 3, image_size, image_size, dtype=torch.float32)
        
        with torch.no_grad():
            pytorch_visual_out = pytorch_model.visual(test_image).numpy()
        
        onnx_visual_out = visual_session.run(
            None,
            {"input": test_image.numpy()}
        )[0]
        
        visual_similarity = np.dot(
            pytorch_visual_out[0] / np.linalg.norm(pytorch_visual_out[0]),
            onnx_visual_out[0] / np.linalg.norm(onnx_visual_out[0])
        )
        
        print(f"  Visual encoder cosine similarity: {visual_similarity:.6f}")
        
        if visual_similarity > 0.999:
            print("  ✓ PASS: Visual encoder outputs match")
        else:
            print(f"  ✗ WARN: Visual encoder similarity is {visual_similarity:.6f} (expected > 0.999)")
        
        # Test text encoder
        print("Testing text encoder...")
        test_tokens = torch.randint(0, 49408, (1, context_length), dtype=torch.long)
        
        with torch.no_grad():
            pytorch_text_out = pytorch_model.encode_text(test_tokens, normalize=False).numpy()
        
        onnx_text_out = text_session.run(
            None,
            {"input": test_tokens.numpy().astype(np.int64)}
        )[0]
        
        text_similarity = np.dot(
            pytorch_text_out[0] / np.linalg.norm(pytorch_text_out[0]),
            onnx_text_out[0] / np.linalg.norm(onnx_text_out[0])
        )
        
        print(f"  Text encoder cosine similarity: {text_similarity:.6f}")
        
        if text_similarity > 0.999:
            print("  ✓ PASS: Text encoder outputs match")
        else:
            print(f"  ✗ WARN: Text encoder similarity is {text_similarity:.6f} (expected > 0.999)")
        
        print("\n✓ Validation complete")
        
    except Exception as e:
        print(f"✗ Validation failed: {e}")


def main():
    parser = argparse.ArgumentParser(
        description="Export CLIP models to ONNX format for omni-search"
    )
    parser.add_argument(
        "--model",
        type=str,
        default="openclip-vit-l14-336",
        choices=list(MODEL_CONFIGS.keys()),
        help="Model to export (default: openclip-vit-l14-336)"
    )
    parser.add_argument(
        "--output",
        type=str,
        default="../models",
        help="Output directory for ONNX models (default: ../models)"
    )
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Validate exported models against PyTorch (requires onnxruntime)"
    )
    parser.add_argument(
        "--opset",
        type=int,
        default=17,
        help="ONNX opset version (default: 17)"
    )
    
    args = parser.parse_args()
    
    export_onnx_model(
        model_name=args.model,
        output_dir=args.output,
        validate=args.validate,
        opset_version=args.opset
    )


if __name__ == "__main__":
    main()
