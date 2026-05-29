# START HERE 👋 (read this first)

This is the human-friendly map of what's in this folder and *why*. No jargon —
anything technical gets defined the first time it shows up.

---

## What you (and I) just built, in one paragraph

**Mneme** is a small program that gives *any* AI assistant the ability to search
your photos and videos by describing them in plain English ("rider mid-air at
sunset") or by handing it an example image. It runs entirely on your machine.
The clever part: it speaks a standard called **MCP**, so it plugs straight into
OpenClaw, Hermes, Claude Desktop, Cursor — *and* into your own polymathes agent —
without any of them needing to know anything about how it works inside.

## Define the words

- **MCP (Model Context Protocol):** a common "plug shape" for AI tools. If your
  tool speaks MCP, any MCP-compatible assistant can use it. Think USB for AI
  tools — one standard plug, works everywhere.
- **MCP server:** a program that *offers* tools over that plug. Mneme is one.
- **MCP client / host:** the assistant that *uses* those tools (Claude Desktop,
  Hermes, OpenClaw...).
- **CLIP:** an AI model that turns an image *and* a piece of text into numbers
  in the same "space," so "sunset" lands near a picture of a sunset. That's what
  makes searching photos by words possible.
- **Embedding / vector:** the list of numbers CLIP produces for an image or
  phrase. We store these and compare them to find matches.
- **PyPI (the "Python Package Index"):** the public app store for Python
  programs. When we "publish to PyPI," anyone can install Mneme by typing
  `pip install mneme-mcp`. Right now it only lives in your repo; publishing makes
  the one-line install in the demo actually work for strangers. It's free.

## The big realization (why this matters for your repo)

Your agent in `core-node/src/tools/builtin/media.ts` is currently a **stub** —
every media tool just returns *"media-memory MCP server not connected."* It was
always *designed* to get its media powers from an external MCP server. Mneme is
that server. So Mneme:

1. makes *your own* polymathes agent's media tools actually work, **and**
2. makes *everyone else's* agent gain the same powers.

One small program, two payoffs. That's the whole strategy in a sentence.

---

## File-by-file map of `mneme/`

```
mneme/
├── START_HERE.md            ← you are here
├── README.md                ← the public pitch (what users see on GitHub)
├── pyproject.toml           ← the "recipe": name, version, dependencies, install commands
├── LICENSE                  ← MIT (free to use/fork)
│
├── src/mneme/               ← the actual program
│   ├── server.py            ← THE MCP SERVER. Defines the 4 tools agents call.
│   ├── cli.py               ← the `mneme` terminal command (index / search / info)
│   ├── config.py            ← settings (where the database is, which AI backend)
│   ├── store.py             ← the local database (SQLite) that holds the vectors
│   ├── embedder.py          ← turns images/text into vectors (CLIP, or a fallback)
│   ├── indexer.py           ← walks a folder and feeds every file to the embedder
│   ├── pathmeta.py          ← reads your folder names → brand / reel-vs-photo tags
│   └── native.py            ← optional: hand the heavy work to your C++/GPU engine
│
├── tests/                   ← automated checks (17 of them, all passing)
├── scripts/
│   ├── demo.sh              ← a 60-second runnable demo (no GPU needed)
│   └── smoke_mcp.py         ← proves the MCP plug works end-to-end
├── examples/                ← copy-paste configs for each assistant
│   ├── claude_desktop.json
│   ├── cursor_mcp.json
│   ├── hermes.md
│   └── openclaw.md
└── docs/
    ├── DEMO_SCRIPT.md       ← exact script for your video
    ├── UPSTREAM_PITCH.md    ← where/how to submit + the get-hired plan
    └── ROADMAP.md           ← the AI VIDEO EDITING plan (your real north star)
```

If you only open three files in the IDE: **`src/mneme/server.py`** (the tools),
**`src/mneme/pathmeta.py`** (the creator-aware magic), and **`docs/ROADMAP.md`**
(where this is going).

---

## "Does this give them video?" — the honest answer

Two different things share the word "video," so let's split them:

| | What it means | Does Mneme do it today? |
|---|---|---|
| Video **memory** | *Find* the right clip / the right moment in a clip | ✅ Yes — it embeds video **frames** with timestamps, so "find the backflip" returns the clip and the second it happens |
| Video **editing** | *Change* the clip — cut, caption, color, render a reel | ❌ Not yet — that's the **next** wedge (see `docs/ROADMAP.md`) |

So today Mneme makes your library *findable*. The editing layer is the next
build — and the good news is it sits naturally on top of what's already here
(more on that in the roadmap). **This is why your GPU-measuring idea is smart**,
and it's covered next.

---

## Want me to keep going? Pick from this list

1. **Publish to PyPI** so `pip install mneme-mcp` works for everyone (I'll add the
   GitHub Action that does it automatically on each release).
2. **Build the video-editing MCP** described in `docs/ROADMAP.md`.
3. **Prep the submissions** to other repos (`docs/UPSTREAM_PITCH.md` has the list).

Just tell me a number.
