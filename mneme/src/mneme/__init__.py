"""Mneme — local visual memory for any AI agent.

A zero-friction MCP server that gives any MCP-speaking agent (OpenClaw, Hermes,
Claude Desktop, Cursor, ...) the ability to semantically search a local library
of photos and video by natural language or by-image similarity.

The capability originates from the polymathes ``media-memory`` engine. Mneme is
the portable, pip-installable front door to it: it ships a pure-Python CLIP
backend for instant adoption and can optionally delegate to the fast
CUDA + TensorRT C++ binary when one is present (``MNEME_NATIVE_BIN``).
"""

__version__ = "0.1.0"

# Tool surface kept identical to the polymathes media-memory MCP server so the
# two are drop-in compatible.
ASSET_TYPES = ("image", "video_segment", "audio_segment", "document", "code")

__all__ = ["__version__", "ASSET_TYPES"]
