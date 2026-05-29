# Getting noticed: the upstream-contribution playbook

The point of Mneme is not to win a framework war. It's to be the best-in-class
*component* that the big agents don't have, so their users adopt it and their
maintainers notice you. This file is the concrete plan for that.

## Principle

> Contributors and recognition follow **users and momentum**, not feature
> counts. Mneme rides OpenClaw's and Hermes's existing momentum instead of
> trying to manufacture its own from zero.

## Step 1 — make adoption a 30-second action

Already done: `uvx --from 'mneme-mcp[clip]' mneme-mcp`. No build, no CUDA, no
clone. This is the single most important growth lever — protect it.

## Step 2 — land where the eyeballs are

| Channel | Action | Why |
|---|---|---|
| MCP directories | Submit Mneme to awesome-mcp-servers + the official registry | Passive discovery |
| OpenClaw Discord | Share the demo + `mcporter add` one-liner | Their users want media search |
| Nous/Hermes Discord | Share the `hermes mcp add` one-liner | Same |
| r/LocalLLaMA, X | Post the 10s hook clip | Broad local-AI audience |

## Step 3 — open *small, high-quality* upstream issues/PRs

Don't ask them to depend on you. Make their product better and reference Mneme
as the easy path. Suggested, in order of likely acceptance:

### Hermes (NousResearch/hermes-agent) — best first target
- **Docs PR:** add a short "Visual / media memory" recipe to the MCP guide
  showing `hermes mcp add mneme`. Low-risk, high-visibility, helps their users.
- **Skill PR:** contribute an `agentskills.io`-compatible skill `visual-memory`
  that wires Mneme's tools into a creator workflow. Hermes is skill-centric and
  this is exactly the kind of contribution they invite.
- Why Hermes first: Nous actively *hires*, they welcome contributions, and
  they're already absorbing OpenClaw users (so your name travels).

### OpenClaw (openclaw/openclaw)
- **Docs/skill PR:** a ClawHub-style entry or a docs recipe for adding Mneme via
  `mcporter`. OpenClaw explicitly welcomes AI/vibe-coded PRs.

### Both
- Offer a tiny `media-memory` example in their "community MCP servers" lists.

## Step 4 — the hiring throughline

What a hiring manager at an AI lab / infra startup actually evaluates:

1. **Rare, verifiable skill.** Your real asset is the CUDA + TensorRT FP16
   inference path and the cooperative GPU arbitration in polymathes. Mneme is
   the *legible front door* that gets people to that code. Link it prominently.
2. **Merged PRs in repos they recognise.** One accepted PR to Hermes/OpenClaw is
   a stronger signal than 10k stars on a solo framework.
3. **A 60-second story.** "I built the visual-memory layer the big agents lack,
   and it plugs into all of them" — that's the line. Lead with it everywhere.

## Anti-goals (don't do these)

- Don't rebuild OpenClaw/Hermes features (channels, chat memory, cron). That's
  the unwinnable race; it buries your differentiator.
- Don't oversell. The advanced video/audio extras in polymathes are stubbed in
  public; say so. Credibility is the asset you're actually building.
