# Mneme — video demo script

Target length: **90 seconds**. Goal: a viewer understands the wedge and wants to
`uvx` it before the clip ends. Record at 1080p, terminal + a file explorer
showing a real media folder.

---

## The 10-second hook (say this first, on camera or voiceover)

> "Your AI agent can read your files. It can't *see* your photos and video.
> This gives any agent — OpenClaw, Hermes, Claude Desktop — local visual memory
> in one command. No cloud, no API bill."

Cut straight to terminal. Don't explain architecture yet.

---

## Beat 1 — install (15s)

```bash
uvx --from 'mneme-mcp[clip]' mneme-mcp --help    # or: pip install 'mneme-mcp[clip]'
```

Say: *"One line. It's an MCP server, so it plugs into the agent you already use."*

## Beat 2 — index a real library (20s)

Show a folder like `D:\MyContent\content\skating\reels` with actual clips/photos.

```bash
mneme index ~/MyContent
mneme info        # "assets": 412
```

Say: *"It just embedded every photo and every video frame, locally, on my GPU."*

## Beat 3 — the money shot: natural-language visual search (25s)

```bash
mneme search "rider mid-air against a sunset, vertical" --top-k 5
```

Point at a result path and **open that exact image** in the explorer. Let the
match land visually — that's the whole pitch in one frame.

Say: *"I never tagged these. It found it by what the image looks like."*

## Beat 4 — it's creator-aware (15s)

```bash
mneme search "clean rider shot" --top-k 5
# show the [skating] brand tag + intent=photo in the output
```

Say: *"It reads my folder convention — brand, reel vs photo, and it flags
finished content so the agent won't re-cut my published work."*

## Beat 5 — inside the agent (10s)

Switch to Claude Desktop / Hermes / OpenClaw. Ask in plain language:

> "Find me a vertical rider photo from the skating brand for a blog header."

Show the agent calling `media_search` and returning the image inline.

## Close (5s)

> "Local. Private. Works with any agent. Link in the description. Star it if your
> agent should be able to see."

---

## Recording checklist

- [ ] Use a **real** media folder (authenticity sells this).
- [ ] Pre-warm the model once before recording (first run downloads weights).
- [ ] Keep one terminal, large font, dark theme.
- [ ] Have the matched image ready to reveal — the visual "click" is the hook.
- [ ] End on the GitHub URL on screen for 3+ seconds.

## Distribution (where it actually gets seen)

- Post the clip in the **OpenClaw** and **Nous/Hermes** Discords as "I built an
  MCP server that gives your agent visual memory" — with the one-line install.
- Cross-post to r/LocalLLaMA and X with the 10s hook as the caption.
- Submit to MCP server directories / awesome-mcp lists.
- Open the upstream issues described in `UPSTREAM_PITCH.md` the same day.
