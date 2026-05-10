# @polymath/gateway

The Node.js/TypeScript runtime for Polymath — a media-native agentic framework.

## Install

```bash
npm install -g @polymath/gateway
```

Requires Node.js ≥ 22.

## Usage

```bash
# First run — creates ~/.polymath/config.toml
polymath

# One-shot task
polymath agent "summarize this PDF"

# Interactive REPL
polymath agent --repl

# Start gateway server only
polymath
```

## Configuration

Edit `~/.polymath/config.toml` to set your LLM API key, enable transports (Telegram, Discord), and configure MCP capabilities.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Capability Authoring](docs/CAPABILITY_AUTHORING.md)
- [Skill Authoring](docs/SKILL_AUTHORING.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Remote Access](docs/REMOTE.md)

## License

MIT
