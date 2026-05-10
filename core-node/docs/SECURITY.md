# Security

## Bearer token

Every inbound HTTP request (webhooks, web UI) must include a bearer token:

```
Authorization: Bearer <token>
```

The token is generated during `polymath onboard` and stored in `~/.polymath/config.toml` under `security.bearer_token`.

## Pairing flow

New devices/channels pair via a one-time code:

1. Run `polymath pair` — prints a 6-digit code valid for 5 minutes
2. Send that code to the bot on the channel you want to authorize
3. The channel is added to the allow-list in config

Only paired channels can issue commands.

## Sandbox policy

Tool execution is governed by a sandbox policy (`security.sandbox`):

- `allow` — list of tool name patterns the agent may call without confirmation
- `deny` — blocked tools (never executed)
- `confirm` — tools that require user approval before execution

Default policy denies destructive filesystem and network operations.

## Audit log

All tool calls, LLM requests, and channel messages are logged to `~/.polymath/audit.db` (SQLite). Each entry records:

- Timestamp
- Channel + user ID
- Action (tool name or event type)
- Input/output summary
- Approval status (auto / confirmed / denied)

View with `polymath audit` or query the DB directly.
