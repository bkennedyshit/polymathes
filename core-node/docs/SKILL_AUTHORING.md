# Skill Authoring

A **skill** is a reusable prompt template that the agent can invoke as a tool. Skills are defined as `SKILL.md` files discovered from `~/.polymath/skills/`.

## File Format

```markdown
---
name: summarize-video
description: Summarize a YouTube video given its URL
version: 1.0.0
author: yourname
tags: [media, youtube]
toolsets: [web, browser]
---

Given the YouTube video at {{input}}, fetch the transcript and produce a concise summary covering:
1. Main topic
2. Key points (bullet list)
3. Actionable takeaways
```

## Frontmatter Fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Unique skill identifier (used as `skill.{name}` tool) |
| `description` | Yes | One-line description shown to the agent |
| `version` | No | Semver version string |
| `author` | No | Author name |
| `tags` | No | Array of tags for filtering |
| `toolsets` | No | Which toolsets the skill needs access to |

## Discovery

At boot, Polymath scans `{home_dir}/skills/` recursively for `SKILL.md` files. Each valid skill is registered as a tool named `skill.{name}`.

## Directory Structure

```
~/.polymath/skills/
├── summarize-video/
│   └── SKILL.md
├── draft-email/
│   └── SKILL.md
└── code-review/
    └── SKILL.md
```

## Example: Code Review Skill

```markdown
---
name: code-review
description: Review a code diff and suggest improvements
version: 1.0.0
tags: [dev, review]
toolsets: [files, terminal]
---

Review the following code change and provide:
- Bugs or logic errors
- Performance concerns
- Style suggestions

Input: {{input}}
```

## Using Skills

From the CLI: just ask the agent naturally. The orchestrator will select the appropriate skill tool when relevant.

From the API: call the tool directly:
```json
{"name": "skill.code-review", "arguments": {"input": "..."}}
```
