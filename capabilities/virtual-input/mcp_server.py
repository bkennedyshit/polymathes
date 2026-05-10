#!/usr/bin/env python3
"""
mcp_server.py - MCP stdio wrapper around virtual_input.py.

Speaks Model Context Protocol over stdin/stdout so Polymath's Gateway can call
virtual-input tools the same way it calls media-memory.

Run:
    python mcp_server.py              # Xvfb :99 (default Linux isolated display)
    python mcp_server.py --display :0 # user's real desktop (dangerous)

Polymath config:
    {
      "mcp_servers": [
        {
          "name": "virtual-input",
          "command": "python",
          "args": ["/path/to/capabilities/virtual-input/mcp_server.py"]
        }
      ]
    }

All tool calls are gated by Polymath's sandbox policy. By default the `input` toolset
is DENIED; the user must explicitly allow it in ~/.polymath/polymath.json.

Protocol: https://spec.modelcontextprotocol.io  (2024-11-05)
Implementation is hand-rolled (no SDK dependency) to keep this script small.
"""

import json
import sys
import threading
import traceback
from typing import Any

try:
    from virtual_input import VirtualInput, SCREEN_WIDTH, SCREEN_HEIGHT, start_xvfb, launch_chrome_on_virtual_display
except ImportError as e:
    print(json.dumps({
        "jsonrpc": "2.0", "id": None,
        "error": {"code": -32000, "message": f"virtual_input.py import failed: {e}"}
    }), flush=True)
    sys.exit(1)


PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "virtual-input"
SERVER_VERSION = "0.1.0"

TOOLS = [
    {
        "name": "input_move",
        "description": "Move the virtual mouse cursor to (x, y). Uses a natural Bezier curve with jitter so events are indistinguishable from hardware.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "x": {"type": "integer", "description": "X coordinate in screen pixels"},
                "y": {"type": "integer", "description": "Y coordinate in screen pixels"}
            },
            "required": ["x", "y"]
        }
    },
    {
        "name": "input_click",
        "description": "Click at the current (or specified) cursor position. Default button: left.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "x": {"type": "integer"},
                "y": {"type": "integer"},
                "button": {"type": "string", "enum": ["left", "right", "middle"], "default": "left"},
                "double": {"type": "boolean", "default": False}
            }
        }
    },
    {
        "name": "input_type",
        "description": "Type text with natural variable-rate keystrokes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "wpm": {"type": "number", "description": "Words per minute, default random 65-95"}
            },
            "required": ["text"]
        }
    },
    {
        "name": "input_hotkey",
        "description": "Press a key combination (e.g. ['ctrl','a'] or ['alt','tab']).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "keys": {"type": "array", "items": {"type": "string"}}
            },
            "required": ["keys"]
        }
    },
    {
        "name": "input_scroll",
        "description": "Scroll the mouse wheel. Positive = up, negative = down.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "amount": {"type": "integer", "default": -3}
            }
        }
    },
    {
        "name": "input_screenshot",
        "description": "Capture the virtual display and save it to a file. Returns the absolute path.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Output path; default /tmp/polymath_vi_snap.png"}
            }
        }
    },
    {
        "name": "input_spawn_browser",
        "description": "Launch Chrome on the virtual display with remote debugging enabled. Returns the CDP endpoint URL so an agent can attach via Playwright or browser-use.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "cdp_port": {"type": "integer", "default": 9299}
            }
        }
    }
]


# --- Tool execution ---

_vi: VirtualInput | None = None
_vi_lock = threading.Lock()


def get_vi() -> VirtualInput:
    """Lazy-init VirtualInput. Creates the Xvfb display and uinput device on first use."""
    global _vi
    with _vi_lock:
        if _vi is None:
            _vi = VirtualInput()
        return _vi


_BUTTON_MAP = {"left": None, "right": None, "middle": None}


def _lookup_buttons() -> None:
    try:
        from evdev import ecodes as e
        _BUTTON_MAP["left"] = e.BTN_LEFT
        _BUTTON_MAP["right"] = e.BTN_RIGHT
        _BUTTON_MAP["middle"] = e.BTN_MIDDLE
    except Exception:
        pass


_lookup_buttons()


def call_tool(name: str, args: dict) -> dict:
    """Dispatch a tool call. Returns the MCP content-array response payload."""
    if name == "input_move":
        get_vi().move_to(int(args["x"]), int(args["y"]))
        return text_result(f"moved to ({args['x']}, {args['y']})")

    if name == "input_click":
        vi = get_vi()
        button = _BUTTON_MAP.get(args.get("button", "left")) or _BUTTON_MAP["left"]
        double = bool(args.get("double", False))
        if "x" in args and "y" in args:
            vi.click_at(int(args["x"]), int(args["y"]), button=button, double=double)
            return text_result(f"clicked at ({args['x']}, {args['y']})")
        vi.click(button=button, double=double)
        return text_result("clicked at current position")

    if name == "input_type":
        get_vi().type_text(str(args["text"]), wpm=args.get("wpm"))
        return text_result(f"typed {len(args['text'])} chars")

    if name == "input_hotkey":
        keys = args.get("keys") or []
        get_vi().hotkey(*keys)
        return text_result(f"pressed {'+'.join(keys)}")

    if name == "input_scroll":
        amt = int(args.get("amount", -3))
        get_vi().scroll(amt)
        return text_result(f"scrolled {amt}")

    if name == "input_screenshot":
        path = args.get("path", "/tmp/polymath_vi_snap.png")
        out = get_vi().screenshot(path)
        return text_result(out)

    if name == "input_spawn_browser":
        # Ensure Xvfb up (creates it on first VirtualInput() as well)
        start_xvfb()
        port = int(args.get("cdp_port", 9299))
        _, port = launch_chrome_on_virtual_display(debug_port=port)
        return text_result(f"chrome ready at http://127.0.0.1:{port}")

    return error_result(-32601, f"unknown tool: {name}")


def text_result(text: str) -> dict:
    return {"content": [{"type": "text", "text": text}]}


def error_result(code: int, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


# --- MCP stdio protocol ---

def send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def handle(request: dict) -> None:
    method = request.get("method")
    req_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        send({
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION}
            }
        })
        return

    if method == "notifications/initialized":
        return  # notification, no response

    if method == "tools/list":
        send({"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}})
        return

    if method == "tools/call":
        tool_name = params.get("name", "")
        tool_args = params.get("arguments", {}) or {}
        try:
            result = call_tool(tool_name, tool_args)
            if "error" in result:
                send({"jsonrpc": "2.0", "id": req_id, "error": result["error"]})
            else:
                send({"jsonrpc": "2.0", "id": req_id, "result": result})
        except Exception as e:
            send({
                "jsonrpc": "2.0", "id": req_id,
                "error": {"code": -32000, "message": f"{type(e).__name__}: {e}", "data": traceback.format_exc()}
            })
        return

    # Unknown method
    if req_id is not None:
        send({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"method not found: {method}"}})


def main() -> None:
    # Never emit on stdout outside of JSON-RPC. Everything else to stderr.
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            print(f"[virtual-input] invalid JSON: {e}", file=sys.stderr)
            continue
        try:
            handle(req)
        except Exception as e:
            print(f"[virtual-input] handler error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    main()
