# Using Mneme with OpenClaw

[OpenClaw](https://github.com/openclaw/openclaw) reaches MCP servers through
`mcporter` (and packages them as skills). Mneme is a standard stdio MCP server,
so it drops in the same way any server does.

## Add Mneme via mcporter

```bash
mcporter add mneme -- uvx --from 'mneme-mcp[clip]' mneme-mcp
```

With config:

```bash
MNEME_DB_PATH=~/.mneme/mneme.db \
MNEME_BACKEND=auto \
mcporter add mneme -- uvx --from 'mneme-mcp[clip]' mneme-mcp
```

Then list to confirm the tools are visible to OpenClaw:

```bash
mcporter list mneme
# media_index  media_search  media_search_by_image  media_describe
# gpu_status   gpu_release   gpu_reclaim            gpu_evacuate
```

## Try it from any channel

Message your OpenClaw assistant (WhatsApp/Telegram/Discord/etc.):

```
Index ~/MyContent, then find me a clean rider photo for a blog header —
skating brand, photo only, shot vertical.
```

The agent calls `media_index` then `media_search`, and filters hits on
`metadata.brand == "skating"` and `metadata.intent == "photo"`.

## Notes

- Mneme stays entirely local — nothing leaves the machine OpenClaw runs on.
- Point `MNEME_NATIVE_BIN` at the polymathes C++ engine for TensorRT speed on
  large libraries.
