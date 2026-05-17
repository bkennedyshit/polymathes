# {{BRAND}}

Brand-scoped content directory.

## Where things go

- `input/{{BRAND}}/raw/`  — raw camera files, untouched
- `input/{{BRAND}}/fixed/`  — color-corrected, ready for cuts
- `content/{{BRAND}}/reels/`  — finished reels, posted-or-postable
- `content/{{BRAND}}/long-form/`  — long-form videos
- `content/{{BRAND}}/static/`  — static images / posters
- `content/{{BRAND}}/talking-head/`  — talking-head format videos

## What the agent will do

- Files in `input/{{BRAND}}/` are fair game for skills (edit, analyze,
  reel extraction, etc.)
- Files in `content/{{BRAND}}/reels/` are treated as **finished** —
  the agent will warn if you ask it to re-cut them
- Workflow state is tracked in `~/.polymath/polymath.db` so the agent
  can answer questions like "have I reeled this raw session yet?"
