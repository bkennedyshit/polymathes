# virtual-input

Kernel-level virtual mouse and keyboard for agent-driven desktop automation. Indistinguishable from real hardware input because it **is** real hardware input — events originate at the kernel HID layer, not a JS runtime.

## Status

- **Linux:** Functional. Uses `uinput` + Xvfb isolated display (`:99`) so the agent drives a virtual desktop while the user's physical desktop stays untouched.
- **Windows:** In progress. Planned backend: signed kernel driver producing `WM_INPUT` HID events. Interim: [Interception](https://github.com/oblitum/Interception) driver as a bridge.
- **macOS:** Not planned for v1.

## Why this exists

Every agent framework automates the desktop the same way: Playwright / Puppeteer for browsers, PyAutoGUI / pynput for desktop apps. All of them are detectable:

- Playwright sets `navigator.webdriver = true` unless patched
- Puppeteer-stealth fails Cloudflare Turnstile and reCAPTCHA v3 because timing distributions are too clean
- PyAutoGUI on Windows uses `SendInput` with the `LLMHF_INJECTED` flag that anti-cheat and anti-automation tooling reads directly
- Event timing is uniform when the library isn't adding jitter

A kernel-level HID driver:
1. Registers as a real input device with the OS
2. Produces events with the same flag set as physical hardware
3. Gets natural jitter via the Bezier mouse path + variable keystroke delays in this module

## Architecture (Linux)

```
Agent (Python or via MCP tool call)
        │
        ▼
VirtualInput (this module)
        │
   /dev/uinput  ←── kernel HID layer
        │
        ▼
Xvfb display :99 (isolated virtual screen)
        │
        ▼
Chrome / app running on DISPLAY=:99
```

The user's real desktop (`:0` or Wayland) is never touched. The agent gets a full 1920×1080 virtual workstation it can click, type, and screenshot in — and the user can work uninterrupted on their actual monitors.

## Linux setup

```bash
# Install dependencies
sudo apt install python3-evdev xvfb scrot ffmpeg

# Grant uinput access
echo 'KERNEL=="uinput", GROUP="input", MODE="0660"' | sudo tee /etc/udev/rules.d/99-uinput.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
sudo usermod -aG input $USER
# Log out and back in
```

## Usage

### CLI

```bash
# Start the virtual display
python virtual_input.py --start-display

# Launch Chrome on the virtual display with CDP enabled
python virtual_input.py --chrome

# Test input
python virtual_input.py --test
python virtual_input.py --click 960 540
python virtual_input.py --type "hello world"
python virtual_input.py --screenshot /tmp/snap.png
```

### Python API

```python
from virtual_input import VirtualInput

with VirtualInput() as vi:
    vi.move_to(960, 540)          # natural bezier path
    vi.click()
    vi.type_text("hello", wpm=80) # variable-speed typing
    vi.screenshot("/tmp/out.png")
```

## MCP server

Run the MCP stdio server:

```bash
cd capabilities/virtual-input
python3 mcp_server.py
```

The server reads JSON-RPC messages from stdin and writes responses to stdout. Connect it to any MCP client (Polymath core, Claude Code, etc.) via stdio transport.

Requires Linux with `uinput` access and `evdev` installed. On Windows it exits with an error.

## MCP tool surface

### `input_click`
```json
{ "x": "number", "y": "number", "button": "left|right|middle", "double": "boolean" }
```

### `input_type`
```json
{ "text": "string", "wpm": "number (optional, default random 65-95)" }
```

### `input_hotkey`
```json
{ "keys": "string[] (e.g. ['ctrl','a'])" }
```

### `input_screenshot`
```json
{ "path": "string" }  // returns absolute path
```

### `input_launch_browser`
```json
{ "url": "string (optional)", "cdp_port": "number (optional, default 9299)" }
```
Returns `{ "cdp_url": "http://127.0.0.1:9299" }` so other agents (Playwright, browser-use) can attach.

## Security

This capability has broad blast radius — an agent with access to virtual-input can do anything a user can do in the virtual display. Polymath's core runtime will gate it behind:
- Explicit allowlist in agent config
- Sandbox to the Xvfb display only (no passthrough to `:0`)
- Audit log of every call (JSONL with timestamp, tool, args)
- Optional human-in-the-loop approval for destructive actions

## Windows port notes

Options being evaluated:
1. **Interception driver** — open-source, functional, but requires user driver install. Fast path to shipping.
2. **Custom WDF driver** — signed via Microsoft attestation ($400/yr dev account + validation). Ships as a single installer. Long path.
3. **vJoy-style virtual device** — simpler but flagged by more anti-cheat tooling.

Likely plan: ship Interception support first, build signed WDF driver in parallel.
