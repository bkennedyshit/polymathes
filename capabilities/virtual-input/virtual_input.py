#!/usr/bin/env python3
"""
virtual_input.py — Kernel-level virtual mouse + keyboard via uinput + Xvfb.

Runs all AI input on an ISOLATED virtual display (Xvfb :99) so Billy's
physical desktop is 100% untouched. No MPX, no xinput, no cursor hijacking.

Architecture:
    Xvfb :99 (1920x1080)  ←  uinput virtual device  ←  AI agent
         ↓
    Chrome --display=:99   ←  Playwright/browser-use connects here

Usage:
    from virtual_input import VirtualInput
    vi = VirtualInput()          # spawns Xvfb :99 if not running
    vi.move_to(960, 540)
    vi.click()
    vi.type_text("hello")
    vi.close()

CLI:
    python3 virtual_input.py --test
    python3 virtual_input.py --click 960 540
    python3 virtual_input.py --type "hello world"
    python3 virtual_input.py --screenshot /tmp/snap.png
    python3 virtual_input.py --start-display      # just start Xvfb
    python3 virtual_input.py --chrome              # launch Chrome on :99
"""

import time
import random
import math
import argparse
import subprocess
import sys
import os
import signal
import atexit
import logging

log = logging.getLogger("virtual_input")

try:
    import evdev
    from evdev import UInput, ecodes as e
    EVDEV_AVAILABLE = True
except ImportError:
    EVDEV_AVAILABLE = False

# ── Display config ───────────────────────────────────────────────────────────
VIRTUAL_DISPLAY = os.environ.get("VI_DISPLAY", ":99")
SCREEN_WIDTH = int(os.environ.get("VI_SCREEN_W", 1920))
SCREEN_HEIGHT = int(os.environ.get("VI_SCREEN_H", 1080))
SCREEN_DEPTH = 24

# ── Xvfb management ─────────────────────────────────────────────────────────
_xvfb_proc = None

def is_display_running(display=VIRTUAL_DISPLAY):
    """Check if a display server is already running on this display number."""
    lock_file = f"/tmp/.X{display.replace(':', '')}-lock"
    if os.path.exists(lock_file):
        try:
            with open(lock_file) as f:
                pid = int(f.read().strip())
            os.kill(pid, 0)  # check if process exists
            return True
        except (ValueError, ProcessLookupError, PermissionError):
            # Stale lock file — clean it up
            try:
                os.unlink(lock_file)
            except OSError:
                pass
    return False

def start_xvfb(display=VIRTUAL_DISPLAY, width=SCREEN_WIDTH, height=SCREEN_HEIGHT):
    """Start Xvfb virtual display if not already running."""
    global _xvfb_proc

    if is_display_running(display):
        log.info(f"Xvfb {display} already running")
        return display

    cmd = [
        "Xvfb", display,
        "-screen", "0", f"{width}x{height}x{SCREEN_DEPTH}",
        "-ac",           # disable access control (allow any client)
        "-nolisten", "tcp",
        "+extension", "RANDR",
    ]

    _xvfb_proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        preexec_fn=os.setsid,
    )

    # Wait for display to be ready
    for _ in range(30):
        time.sleep(0.1)
        if is_display_running(display):
            log.info(f"✅ Xvfb started on {display} ({width}x{height})")
            atexit.register(stop_xvfb)
            return display

    raise RuntimeError(f"Xvfb failed to start on {display}")

def stop_xvfb():
    """Stop the Xvfb process we started."""
    global _xvfb_proc
    if _xvfb_proc and _xvfb_proc.poll() is None:
        try:
            os.killpg(os.getpgid(_xvfb_proc.pid), signal.SIGTERM)
            _xvfb_proc.wait(timeout=5)
            log.info("Xvfb stopped")
        except Exception:
            pass
    _xvfb_proc = None

def launch_chrome_on_virtual_display(display=VIRTUAL_DISPLAY, debug_port=9299):
    """Launch Chrome on the virtual display with remote debugging."""
    profile_dir = f"/tmp/chrome-virtual-{display.replace(':', '')}"
    os.makedirs(profile_dir, exist_ok=True)

    cmd = [
        "google-chrome-stable",
        f"--remote-debugging-port={debug_port}",
        "--remote-allow-origins=*",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-sandbox",
        "--disable-gpu",
        f"--window-size={SCREEN_WIDTH},{SCREEN_HEIGHT}",
        "--window-position=0,0",
    ]

    env = {**os.environ, "DISPLAY": display}
    proc = subprocess.Popen(
        cmd, env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        preexec_fn=os.setsid,
    )

    # Wait for CDP to be ready
    import urllib.request
    for _ in range(30):
        time.sleep(0.5)
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json/version", timeout=2)
            log.info(f"✅ Chrome on {display} ready (CDP port {debug_port})")
            return proc, debug_port
        except Exception:
            pass

    raise RuntimeError(f"Chrome failed to start on {display}")


# ── Human-like timing ────────────────────────────────────────────────────────
def human_delay(lo=0.05, hi=0.15):
    time.sleep(random.uniform(lo, hi))

def keystroke_delay():
    time.sleep(random.uniform(0.04, 0.12))

def mouse_move_delay():
    time.sleep(random.uniform(0.008, 0.025))


# ── Bezier mouse path ────────────────────────────────────────────────────────
def bezier_path(x0, y0, x1, y1, steps=None):
    """Generate a natural curved mouse path between two points."""
    dist = math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2)
    if steps is None:
        steps = max(8, int(dist / 15))

    mid_x = (x0 + x1) / 2 + random.randint(-40, 40)
    mid_y = (y0 + y1) / 2 + random.randint(-40, 40)

    path = []
    for i in range(steps + 1):
        t = i / steps
        bx = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * mid_x + t ** 2 * x1
        by = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * mid_y + t ** 2 * y1
        bx += random.uniform(-0.5, 0.5)
        by += random.uniform(-0.5, 0.5)
        path.append((int(bx), int(by)))
    return path


# ── Virtual Input Device ─────────────────────────────────────────────────────
class VirtualInput:
    def __init__(self, display=VIRTUAL_DISPLAY, auto_xvfb=True):
        """Create virtual input device on an isolated Xvfb display.
        
        Args:
            display: X display to target (default :99)
            auto_xvfb: automatically start Xvfb if not running
        """
        self.display = display
        self.device = None
        self.current_x = SCREEN_WIDTH // 2
        self.current_y = SCREEN_HEIGHT // 2

        # Ensure virtual display is running
        if auto_xvfb:
            start_xvfb(display)

        # Set DISPLAY for any subprocess calls
        os.environ["DISPLAY"] = display

        self._setup()

    def _setup(self):
        if not EVDEV_AVAILABLE:
            raise RuntimeError(
                "evdev not installed. Run: pip3 install evdev\n"
                "Also ensure /dev/uinput is accessible:\n"
                "  sudo usermod -aG input $USER\n"
                "  echo 'KERNEL==\"uinput\", GROUP=\"input\", MODE=\"0660\"' | "
                "sudo tee /etc/udev/rules.d/99-uinput.rules\n"
                "  sudo udevadm control --reload-rules && sudo udevadm trigger"
            )

        if not os.access("/dev/uinput", os.W_OK):
            raise PermissionError(
                "/dev/uinput not writable. Run setup commands:\n"
                "  sudo usermod -aG input $USER\n"
                "  echo 'KERNEL==\"uinput\", GROUP=\"input\", MODE=\"0660\"' | "
                "sudo tee /etc/udev/rules.d/99-uinput.rules\n"
                "  sudo udevadm control --reload-rules && sudo udevadm trigger\n"
                "Then log out and back in."
            )

        capabilities = {
            e.EV_KEY: [
                e.BTN_LEFT, e.BTN_RIGHT, e.BTN_MIDDLE,
                e.KEY_A, e.KEY_B, e.KEY_C, e.KEY_D, e.KEY_E, e.KEY_F,
                e.KEY_G, e.KEY_H, e.KEY_I, e.KEY_J, e.KEY_K, e.KEY_L,
                e.KEY_M, e.KEY_N, e.KEY_O, e.KEY_P, e.KEY_Q, e.KEY_R,
                e.KEY_S, e.KEY_T, e.KEY_U, e.KEY_V, e.KEY_W, e.KEY_X,
                e.KEY_Y, e.KEY_Z,
                e.KEY_0, e.KEY_1, e.KEY_2, e.KEY_3, e.KEY_4,
                e.KEY_5, e.KEY_6, e.KEY_7, e.KEY_8, e.KEY_9,
                e.KEY_SPACE, e.KEY_ENTER, e.KEY_BACKSPACE, e.KEY_TAB,
                e.KEY_LEFTSHIFT, e.KEY_RIGHTSHIFT,
                e.KEY_LEFTCTRL, e.KEY_RIGHTCTRL,
                e.KEY_LEFTALT, e.KEY_RIGHTALT,
                e.KEY_MINUS, e.KEY_EQUAL, e.KEY_LEFTBRACE, e.KEY_RIGHTBRACE,
                e.KEY_SEMICOLON, e.KEY_APOSTROPHE, e.KEY_GRAVE,
                e.KEY_BACKSLASH, e.KEY_COMMA, e.KEY_DOT, e.KEY_SLASH,
                e.KEY_CAPSLOCK, e.KEY_ESC, e.KEY_DELETE,
                e.KEY_UP, e.KEY_DOWN, e.KEY_LEFT, e.KEY_RIGHT,
                e.KEY_HOME, e.KEY_END, e.KEY_PAGEUP, e.KEY_PAGEDOWN,
            ],
            e.EV_REL: [e.REL_X, e.REL_Y, e.REL_WHEEL],
        }

        self.device = UInput(
            capabilities,
            name="NEPA AI Virtual Mouse",
            vendor=0x1234,
            product=0x5678,
            version=1,
        )
        time.sleep(0.5)
        log.info(f"✅ Virtual input device created on {self.display} (no MPX, Xvfb isolated)")

    def _emit(self, event_type, code, value):
        self.device.write(event_type, code, value)

    def _syn(self):
        self.device.syn()

    def move_to(self, x, y, natural=True):
        """Move virtual mouse to (x, y) with optional natural bezier curve."""
        x = max(0, min(x, SCREEN_WIDTH - 1))
        y = max(0, min(y, SCREEN_HEIGHT - 1))

        if natural:
            path = bezier_path(self.current_x, self.current_y, x, y)
            for px, py in path:
                dx = px - self.current_x
                dy = py - self.current_y
                if dx != 0:
                    self._emit(e.EV_REL, e.REL_X, dx)
                if dy != 0:
                    self._emit(e.EV_REL, e.REL_Y, dy)
                self._syn()
                self.current_x = px
                self.current_y = py
                mouse_move_delay()
        else:
            dx = x - self.current_x
            dy = y - self.current_y
            self._emit(e.EV_REL, e.REL_X, dx)
            self._emit(e.EV_REL, e.REL_Y, dy)
            self._syn()
            self.current_x = x
            self.current_y = y

        human_delay(0.05, 0.12)

    def click(self, button=e.BTN_LEFT, double=False):
        """Click at current position."""
        self._emit(e.EV_KEY, button, 1)
        self._syn()
        human_delay(0.04, 0.09)
        self._emit(e.EV_KEY, button, 0)
        self._syn()

        if double:
            human_delay(0.08, 0.15)
            self._emit(e.EV_KEY, button, 1)
            self._syn()
            human_delay(0.04, 0.09)
            self._emit(e.EV_KEY, button, 0)
            self._syn()

    def click_at(self, x, y, button=e.BTN_LEFT, double=False):
        """Move to (x, y) then click."""
        self.move_to(x, y)
        human_delay(0.05, 0.15)
        self.click(button, double)

    def right_click(self, x=None, y=None):
        if x is not None:
            self.move_to(x, y)
        self.click(button=e.BTN_RIGHT)

    def scroll(self, amount=-3):
        """Scroll up (positive) or down (negative)."""
        for _ in range(abs(amount)):
            self._emit(e.EV_REL, e.REL_WHEEL, 1 if amount > 0 else -1)
            self._syn()
            human_delay(0.02, 0.05)

    def _key_press(self, key_code, shift=False):
        if shift:
            self._emit(e.EV_KEY, e.KEY_LEFTSHIFT, 1)
            self._syn()
        self._emit(e.EV_KEY, key_code, 1)
        self._syn()
        human_delay(0.02, 0.05)
        self._emit(e.EV_KEY, key_code, 0)
        self._syn()
        if shift:
            self._emit(e.EV_KEY, e.KEY_LEFTSHIFT, 0)
            self._syn()

    CHAR_MAP = {
        'a': (e.KEY_A, False), 'b': (e.KEY_B, False), 'c': (e.KEY_C, False),
        'd': (e.KEY_D, False), 'e': (e.KEY_E, False), 'f': (e.KEY_F, False),
        'g': (e.KEY_G, False), 'h': (e.KEY_H, False), 'i': (e.KEY_I, False),
        'j': (e.KEY_J, False), 'k': (e.KEY_K, False), 'l': (e.KEY_L, False),
        'm': (e.KEY_M, False), 'n': (e.KEY_N, False), 'o': (e.KEY_O, False),
        'p': (e.KEY_P, False), 'q': (e.KEY_Q, False), 'r': (e.KEY_R, False),
        's': (e.KEY_S, False), 't': (e.KEY_T, False), 'u': (e.KEY_U, False),
        'v': (e.KEY_V, False), 'w': (e.KEY_W, False), 'x': (e.KEY_X, False),
        'y': (e.KEY_Y, False), 'z': (e.KEY_Z, False),
        'A': (e.KEY_A, True), 'B': (e.KEY_B, True), 'C': (e.KEY_C, True),
        'D': (e.KEY_D, True), 'E': (e.KEY_E, True), 'F': (e.KEY_F, True),
        'G': (e.KEY_G, True), 'H': (e.KEY_H, True), 'I': (e.KEY_I, True),
        'J': (e.KEY_J, True), 'K': (e.KEY_K, True), 'L': (e.KEY_L, True),
        'M': (e.KEY_M, True), 'N': (e.KEY_N, True), 'O': (e.KEY_O, True),
        'P': (e.KEY_P, True), 'Q': (e.KEY_Q, True), 'R': (e.KEY_R, True),
        'S': (e.KEY_S, True), 'T': (e.KEY_T, True), 'U': (e.KEY_U, True),
        'V': (e.KEY_V, True), 'W': (e.KEY_W, True), 'X': (e.KEY_X, True),
        'Y': (e.KEY_Y, True), 'Z': (e.KEY_Z, True),
        '0': (e.KEY_0, False), '1': (e.KEY_1, False), '2': (e.KEY_2, False),
        '3': (e.KEY_3, False), '4': (e.KEY_4, False), '5': (e.KEY_5, False),
        '6': (e.KEY_6, False), '7': (e.KEY_7, False), '8': (e.KEY_8, False),
        '9': (e.KEY_9, False),
        ' ': (e.KEY_SPACE, False), '\n': (e.KEY_ENTER, False),
        '\t': (e.KEY_TAB, False),
        '-': (e.KEY_MINUS, False), '_': (e.KEY_MINUS, True),
        '=': (e.KEY_EQUAL, False), '+': (e.KEY_EQUAL, True),
        '[': (e.KEY_LEFTBRACE, False), '{': (e.KEY_LEFTBRACE, True),
        ']': (e.KEY_RIGHTBRACE, False), '}': (e.KEY_RIGHTBRACE, True),
        ';': (e.KEY_SEMICOLON, False), ':': (e.KEY_SEMICOLON, True),
        "'": (e.KEY_APOSTROPHE, False), '"': (e.KEY_APOSTROPHE, True),
        ',': (e.KEY_COMMA, False), '<': (e.KEY_COMMA, True),
        '.': (e.KEY_DOT, False), '>': (e.KEY_DOT, True),
        '/': (e.KEY_SLASH, False), '?': (e.KEY_SLASH, True),
        '\\': (e.KEY_BACKSLASH, False), '|': (e.KEY_BACKSLASH, True),
        '`': (e.KEY_GRAVE, False), '~': (e.KEY_GRAVE, True),
        '!': (e.KEY_1, True), '@': (e.KEY_2, True), '#': (e.KEY_3, True),
        '$': (e.KEY_4, True), '%': (e.KEY_5, True), '^': (e.KEY_6, True),
        '&': (e.KEY_7, True), '*': (e.KEY_8, True), '(': (e.KEY_9, True),
        ')': (e.KEY_0, True),
    }

    def type_text(self, text, wpm=None):
        """Type text at human speed."""
        if wpm is None:
            wpm = random.uniform(65, 95)
        base_delay = 60.0 / (wpm * 5)

        for char in text:
            if char in self.CHAR_MAP:
                key, shift = self.CHAR_MAP[char]
                self._key_press(key, shift)
            elif char == '\x08':
                self._key_press(e.KEY_BACKSPACE)
            delay = base_delay * random.uniform(0.6, 1.8)
            if random.random() < 0.05:
                delay += random.uniform(0.1, 0.4)
            time.sleep(delay)

    def press_enter(self):
        self._key_press(e.KEY_ENTER)

    def press_tab(self):
        self._key_press(e.KEY_TAB)

    def press_escape(self):
        self._key_press(e.KEY_ESC)

    def press_backspace(self, count=1):
        for _ in range(count):
            self._key_press(e.KEY_BACKSPACE)
            human_delay(0.03, 0.07)

    def hotkey(self, *keys):
        """Press key combo e.g. hotkey('ctrl', 'a')"""
        key_map = {
            'ctrl': e.KEY_LEFTCTRL, 'shift': e.KEY_LEFTSHIFT,
            'alt': e.KEY_LEFTALT, 'enter': e.KEY_ENTER,
            'tab': e.KEY_TAB, 'esc': e.KEY_ESC,
        }
        codes = []
        for k in keys:
            if k in key_map:
                codes.append(key_map[k])
            elif hasattr(e, f'KEY_{k.upper()}'):
                codes.append(getattr(e, f'KEY_{k.upper()}'))

        for code in codes:
            self._emit(e.EV_KEY, code, 1)
            self._syn()
        human_delay(0.04, 0.08)
        for code in reversed(codes):
            self._emit(e.EV_KEY, code, 0)
            self._syn()

    def screenshot(self, path="/tmp/vi_snap.png"):
        """Take screenshot of the virtual display."""
        result = subprocess.run(
            ["scrot", "-z", path],
            env={**os.environ, "DISPLAY": self.display},
            capture_output=True,
        )
        if result.returncode != 0:
            subprocess.run([
                "ffmpeg", "-y", "-f", "x11grab",
                "-i", f"{self.display}.0",
                "-vframes", "1", path,
            ], capture_output=True)
        return path

    def get_display(self):
        """Return the display string for launching apps on the virtual screen."""
        return self.display

    def get_env(self):
        """Return env dict with DISPLAY set for subprocess calls."""
        return {**os.environ, "DISPLAY": self.display}

    def close(self):
        if self.device:
            self.device.close()
            self.device = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


# ── CLI ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    parser = argparse.ArgumentParser(description="Virtual Input Device (Xvfb isolated)")
    parser.add_argument("--test", action="store_true", help="Run basic test")
    parser.add_argument("--click", nargs=2, type=int, metavar=("X", "Y"))
    parser.add_argument("--move", nargs=2, type=int, metavar=("X", "Y"))
    parser.add_argument("--type", dest="type_text", type=str)
    parser.add_argument("--screenshot", type=str)
    parser.add_argument("--start-display", action="store_true", help="Just start Xvfb and exit")
    parser.add_argument("--chrome", action="store_true", help="Launch Chrome on virtual display")
    parser.add_argument("--display", default=VIRTUAL_DISPLAY, help=f"Display (default {VIRTUAL_DISPLAY})")
    parser.add_argument("--chrome-port", type=int, default=9299, help="Chrome CDP port (default 9299)")
    args = parser.parse_args()

    if args.start_display:
        start_xvfb(args.display)
        print(f"✅ Xvfb running on {args.display}")
        print(f"   Launch apps with: DISPLAY={args.display} google-chrome-stable")
        sys.exit(0)

    if args.chrome:
        start_xvfb(args.display)
        proc, port = launch_chrome_on_virtual_display(args.display, args.chrome_port)
        print(f"✅ Chrome on {args.display}, CDP port {port}")
        print(f"   Connect Playwright: cdp_url='http://127.0.0.1:{port}'")
        print(f"   Connect browser-use: Browser(cdp_url='http://127.0.0.1:{port}')")
        print(f"   Press Ctrl+C to stop")
        try:
            proc.wait()
        except KeyboardInterrupt:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        sys.exit(0)

    if args.screenshot:
        start_xvfb(args.display)
        vi = VirtualInput.__new__(VirtualInput)
        vi.device = None
        vi.display = args.display
        path = vi.screenshot(args.screenshot)
        print(f"Screenshot: {path}")
        sys.exit(0)

    try:
        vi = VirtualInput(display=args.display)
        print(f"✅ Virtual input on {args.display} (Xvfb isolated, desktop untouched)")

        if args.test:
            print("Moving mouse to center...")
            vi.move_to(SCREEN_WIDTH // 2, SCREEN_HEIGHT // 2)
            print("Clicking...")
            vi.click()
            print("Typing test...")
            vi.type_text("Hello from NEPA AI virtual input")
            print("✅ Test complete — your desktop was NOT affected")

        elif args.click:
            x, y = args.click
            print(f"Clicking at ({x}, {y})...")
            vi.click_at(x, y)
            print("✅ Clicked")

        elif args.move:
            x, y = args.move
            print(f"Moving to ({x}, {y})...")
            vi.move_to(x, y)
            print("✅ Moved")

        elif args.type_text:
            print(f"Typing: {args.type_text}")
            vi.type_text(args.type_text)
            print("✅ Typed")

        vi.close()

    except PermissionError as ex:
        print(f"❌ Permission error: {ex}")
        sys.exit(1)
    except Exception as ex:
        print(f"❌ Error: {ex}")
        sys.exit(1)
