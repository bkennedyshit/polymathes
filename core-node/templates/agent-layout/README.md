# Your AGENT workspace

This directory is your **content workspace** — the place Polymath looks
for raw inputs, finished output, archives, and skills.

The structure is opinionated on purpose: when an agent (running on your
machine, locally or in the cloud) sees `input/<your-brand>/raw/clip.mp4`,
it knows that's raw footage you want it to process. When it sees
`content/<your-brand>/reels/clip.mp4`, it knows that's already-finished
material and won't try to re-edit it.

Think of this as **RetroArch for content** — the convention is the
contract between you and your agent.

## Layout

```
input/        # drop content here for the agent to process
content/      # owned brand output (your finished work, by brand)
output/       # agent-generated work product
archive/      # read-only references / old material
skills/       # your local skill files (gitignored, never published)
```

Each directory has its own README explaining what goes there and how
the agent interprets paths inside it.

## Adding brands

Polymath organizes content by **brand** — a label you pick (e.g.
`skating`, `podcasting`, `art-channel`, `gaming`, whatever you create
content for). Brand subdirectories live under `input/` and `content/`.

Add a brand:
```
polymath brands add my-brand
```

This creates `input/my-brand/`, `content/my-brand/reels/`,
`content/my-brand/long-form/`, etc.

Or pre-populate at init time:
```
polymath init D:/MyContent --brands=skating,music,art
```

## Indexing your existing files

Once content lives here, run:
```
polymath media seed D:/MyContent
```

The agent will catalog every video and photo with brand, category, and
metadata inferred from the path — no manual tagging required.
