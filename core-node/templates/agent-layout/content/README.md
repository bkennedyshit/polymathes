# content/

**This is your finished, brand-owned output.**

Anything under `content/` is **already done** — published or
ready-to-publish. Polymath will warn before re-editing files in here so
you don't accidentally clobber a finished reel.

## Convention

Organize by brand and format:

```
content/
├── <your-brand>/
│   ├── reels/             # short-form, ready to post (READ-ONLY by default)
│   ├── long-form/         # long-form videos
│   ├── static/            # static images / posters
│   ├── static-images/     # alternate name for the same thing
│   └── talking-head/      # talking-head format videos
├── pinterest/             # platform-specific output (cross-brand)
│   ├── blog pins/
│   ├── generated pins/
│   ├── merch pins/
│   └── video pins/
├── blog-images/           # blog post imagery, audience-tagged
│   └── <audience>/        # e.g. fitness-blog, gear-blog
├── generated-images/      # AI-generated imagery, flat dir
└── obs-recordings/        # raw OBS captures (treated as input by the agent)
```

## What the agent infers from paths under content/

- `content/<brand>/reels/`  → `category=reel`, `workflow_state=ready-to-post`,
   `warn_on_edit=true` (the agent will refuse to re-cut these)
- `content/<brand>/long-form/`  → `category=long-form`
- `content/pinterest/<pin_type>/`  → `category=pin`, platform=pinterest,
   pin_type captured into metadata
- `content/blog-images/<audience>/`  → `category=blog-image`, audience captured
- `content/generated-images/`  → `category=ai-generated`

## Tracking publishes

When you tell the agent "I just posted that reel to Instagram," it
records the event via `media.trace`. Later you can ask:
- "What did I post yesterday?"
- "Which reels haven't I posted to TikTok yet?"
- "Show me the pipeline for this source clip."
