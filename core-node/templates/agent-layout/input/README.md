# input/

**This is where you drop content for the agent to process.**

Anything under `input/` is treated as agent-input — raw material that
hasn't been edited or finished yet. Polymath skills (session editors,
reel extractors, video analyzers, etc.) read from here and write their
output to `output/` or `content/`.

## Convention

Organize by brand:

```
input/
├── <your-brand>/
│   ├── raw/          # direct camera files, untouched
│   └── fixed/        # color-corrected, ready for cuts
└── <another-brand>/
    └── raw/
```

When the agent sees `input/skating/raw/2026-05-14.mp4`, it auto-tags:
- `brand=skating`
- `category=raw`
- `intent=agent-input`

If you skip the `raw/` or `fixed/` subdirectory and put files directly
under `input/<your-brand>/`, they default to `category=raw`.

## What goes here

- Raw camera files
- Screen recordings to be edited
- Audio takes that need cutting
- Photo dumps from a shoot

## What does NOT go here

- Already-finished reels — those go in `content/<your-brand>/reels/`
- Skills you've authored — those go in `skills/`
- AI-generated drafts — those go in `output/` or `content/generated-images/`
