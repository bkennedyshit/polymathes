import type { AppConfig } from './schema.js';

export const defaults: AppConfig = {
  runtime: { home_dir: '~/.polymath', port: 18789, log_level: 'info' },
  llm: { provider: 'openai', model: 'gpt-4o', api_key: '', streaming: true, context_window: 128000, temperature: 0.7 },
  orchestrator: { max_iterations: 25, max_token_budget: 200000, max_subagent_depth: 3 },
  sandbox: { default_mode: 'host', tool_overrides: {} },
  channels: {
    telegram: { token: '', enabled: false },
    discord: { token: '', enabled: false },
    signal: { enabled: false },
    email: { imap: '', smtp: '', enabled: false },
    webchat: { enabled: true },
  },
  mcp_servers: [],
  agents: [],
  memory: { consolidation_model: 'gpt-4o-mini', embedding_model: 'nomic-embed-text', recall_weights: { semantic: 0.5, episodic: 0.3, recency: 0.2 } },
  cron: { enabled: true },
};
