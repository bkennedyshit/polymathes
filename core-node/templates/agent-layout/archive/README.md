# archive/

**Read-only references. Old material the agent can search but won't modify.**

Use this for:
- Historical photo libraries
- Legacy footage from old projects
- Cross-brand reference material
- Source files for repurposing

## Convention

```
archive/
├── <your-brand>/        # by-brand archive
└── <category>/          # ad-hoc category
```

Polymath catalogs archive content with `category=archive` and treats it
as searchable but **never edits it**. If you want the agent to do work
on archive material, copy it to `input/<your-brand>/` first.

## Vision search target

This is one of the most-useful directories for vision-based search.
When you ask "find a clean rider shot for a blog header," the agent
runs CLIP similarity search across photos here and returns matches.

Run the vision indexer once after dropping files:
```
polymath media vision-index archive/
```
