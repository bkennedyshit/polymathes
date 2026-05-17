# output/

**Agent-generated work product.**

When a skill runs (video edit, reel extract, image generation, etc.) and
needs somewhere to write a result, this is the default destination.

## Convention

```
output/
├── <skill-name>/        # one subdir per skill, optional
│   └── <date>-<task>/   # one subdir per run, optional
└── <whatever the skill chose>
```

Files here are **safe to delete** — they're agent output, not your
canonical brand content. Once you decide a piece is keeper-worthy,
move it into `content/<your-brand>/` and trace the move with
`media.trace step=repurpose`.

## What goes here

- Edit decision lists (JSON)
- Scratch renders / preview clips
- Intermediate frame extractions
- Generated thumbnails

## What does NOT go here

- Final published material (move to `content/<brand>/reels/`)
- Anything you'd be sad to lose
