# @polymath/gateway

The Node.js/TypeScript runtime for Polymath — a media-native agentic framework.

## Install

```bash
npm install -g @polymath/gateway
```

Requires Node.js ≥ 22.

## Usage

```bash
# First run — creates ~/.polymath/polymath.json and an auth token
polymath

# One-shot task
polymath agent "summarize this PDF"

# Interactive REPL
polymath agent --repl

# Start gateway server only (web UI at http://localhost:18789)
polymath
```

## Configuration

Edit `~/.polymath/polymath.json` to set your LLM provider/model, enable
transports (Telegram, Discord), and configure MCP capabilities. The file
is created on first boot. Example:

```json
{
  "llm": { "provider": "ollama", "model": "gpt-oss:20b", "base_url": "http://localhost:11434/v1" },
  "memory": { "embedding_model": "nomic-embed-text" }
}
```

The gateway auth token is generated automatically on first boot and stored
at `~/.polymath/auth.key`. Paste it into the web UI when prompted, or run
`polymath show-token` to print it.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Capability Authoring](docs/CAPABILITY_AUTHORING.md)
- [Skill Authoring](docs/SKILL_AUTHORING.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Remote Access](docs/REMOTE.md)

## License

MIT
