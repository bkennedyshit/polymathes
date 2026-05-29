# Roadmap: from visual *memory* to AI video *editing*

This is the bigger vision you're actually chasing — an agent that can **edit
video** using AI models, swapping models on a shared GPU. This doc lays out how
to get there in honest, buildable steps, and shows that your architecture
already anticipates it.

## The thesis

> Memory first, editing second. You can't auto-edit a reel until the agent can
> *find* the moments. Mneme (memory) is the foundation; the editor is the floor
> you build on it.

## Wedge 1 — Mneme (DONE / this PR): visual memory

The agent can locate assets and **moments inside clips**: indexing embeds video
frames with timestamps, so `media_search("biggest air")` already returns *a clip
and the second it happens*. That timestamp is the raw material an editor needs.

## Wedge 2 — the editor (NEXT): a second MCP server

A separate MCP server (working name **Kopis** — a Greek blade — pick your own)
exposing editing tools. Honest split of what's easy vs hard:

| Tool | How it works | GPU needed? | Status |
|---|---|---|---|
| `clip_trim(path, start, end)` | `ffmpeg` cut | no | trivial, ships day 1 |
| `clip_concat([paths])` | `ffmpeg` concat | no | trivial |
| `clip_captions(path)` | speech-to-text (Whisper) → burn-in subs | optional (faster on GPU) | medium |
| `find_highlights(path, "biggest air", n=3)` | **reuse Mneme**: frame-search *within one video* → return time ranges | yes (vision model) | medium — the smart part |
| `auto_reel(path, brief)` | `find_highlights` → `clip_trim` each → `clip_concat` → captions | yes | the headline feature |

The key insight: **`find_highlights` is just Mneme's frame search scoped to one
file.** You already built the hard half. The editor mostly wires
`find_highlights → ffmpeg`.

`ffmpeg` is the universal, free video tool — cuts/concat/encode need **no GPU**.
The GPU only comes in for *understanding* frames (vision model) and *speech*
(Whisper). That separation is what makes this buildable without the stubbed
native extras.

## Why the GPU broker is the whole point (your instinct, confirmed)

You measure VRAM because **editing means running several models on one GPU that
you're also using for Resolve.** Your `core-node/src/gpu/broker.ts` *already*
says so — its own comments list *"the user's video-editing workflows"* as a
first-class reason it arbitrates the GPU, with states like `draining` and a
`ghost claim` for external pressure (you open Resolve, the agent steps off).

A real `auto_reel` run looks like:

```
1. claim GPU
2. load vision model (qwen2.5-vl)   → find_highlights(): which 8s are the trick?
3. evict it, load Whisper           → transcribe for captions
4. evict it                         → ffmpeg trims + concats (CPU, no model)
5. release GPU                      → your main chat model lazy-reloads next msg
```

That model-juggling on one card is the rare, hard, *hireable* engineering — and
it only matters because of the editing use case. Memory + editing + the broker
is a story no other agent tells.

## Honest status of editing in the repo today

- There is **no** `ffmpeg`/trim/render code in the public repo yet (I checked).
- Skills *can* declare a model (e.g., `bmx-session-editor: qwen2.5vl`) and the
  broker *can* swap it, but the editing skill body itself isn't public.
- The advanced video/audio "omni" extras are **stubbed** behind a build flag.

So the editor is a real, designed-for direction — not yet built. Don't claim it
works until it does; *that credibility is your brand.*

## Suggested build order

1. **Mneme on PyPI** (so anything downstream is installable). 
2. **Kopis v0**: `clip_trim` + `clip_concat` over `ffmpeg`. No GPU. Demoable in a day.
3. **`find_highlights`**: reuse Mneme's per-file frame search. This is the wow moment.
4. **`auto_reel`**: chain the above. Record *that* demo.
5. Wire the broker so `find_highlights` claims/releases the GPU cleanly.

## Naming (keep the Greek thread)

Memory = **Mneme**. For the editor: **Kopis** (blade), **Klotho** (the Fate who
spins the thread), or just `mneme-edit`. Your call — easy to rename.
