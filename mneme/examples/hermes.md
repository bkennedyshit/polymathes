# Using Mneme with Hermes Agent

[Hermes](https://github.com/NousResearch/hermes-agent) has a native MCP client:
it connects to MCP servers at startup, discovers their tools, and exposes them
as first-class tools the agent can call.

## Add Mneme

```bash
# uvx runs the published package without a manual install
hermes mcp add mneme -- uvx --from 'mneme-mcp[clip]' mneme-mcp

# or, if you installed it into a venv Hermes can see:
hermes mcp add mneme -- mneme-mcp
```

Set where the catalog lives (optional):

```bash
hermes mcp add mneme \
  --env MNEME_DB_PATH=~/.mneme/mneme.db \
  --env MNEME_BACKEND=auto \
  -- uvx --from 'mneme-mcp[clip]' mneme-mcp
```

Reload tools (or restart) and confirm:

```bash
hermes tools | grep media_
# media_index  media_search  media_search_by_image  media_describe
```

## Try it

```
> index ~/MyContent with media_index, then media_search for
  "rider mid-air against a sunset, vertical, skating brand"
```

Hermes will call `media_index`, then `media_search`, and can filter the returned
hits on `metadata.brand` / `metadata.intent` to honour the "skating brand,
vertical" part of the request.

## Notes

- First run with `[clip]` downloads a small CLIP model (~150 MB) once.
- For a large library on an NVIDIA rig, point Mneme at the native engine:
  `--env MNEME_NATIVE_BIN=/path/to/omni-search` for TensorRT-speed indexing.
