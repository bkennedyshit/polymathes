import { z } from 'zod';

const RuntimeSchema = z.object({
  home_dir: z.string().default('~/.polymath'),
  port: z.number().int().default(18789),
  log_level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

const LlmSchema = z.object({
  provider: z.string().default('openai'),
  model: z.string().default('gpt-4o'),
  base_url: z.string().optional(),
  api_key: z.string().default(''),
  streaming: z.boolean().default(true),
  context_window: z.number().int().default(128000),
  temperature: z.number().default(0.7),
  /**
   * UI-only display field for the openai-codex provider — populated
   * by the gateway after import/login so Settings can show "signed in
   * as <account>". The adapter does NOT read this; it pulls the
   * account_id from the token store on every call.
   */
  codex_account_id: z.string().optional(),
});

const OrchestratorSchema = z.object({
  max_iterations: z.number().int().default(25),
  max_token_budget: z.number().int().default(200000),
  max_subagent_depth: z.number().int().default(3),
});

const SandboxSchema = z.object({
  default_mode: z.enum(['host', 'docker', 'wsl', 'firejail']).default('host'),
  docker_image: z.string().optional(),
  tool_overrides: z.record(z.string(), z.enum(['host', 'docker', 'wsl', 'firejail'])).default({}),
});

const TelegramSchema = z.object({
  token: z.string().default(''),
  enabled: z.boolean().default(false),
  allowed_users: z.array(z.string()).default([]),
  home_channel: z.string().optional(),
});

const DiscordSchema = z.object({
  token: z.string().default(''),
  enabled: z.boolean().default(false),
  allowed_users: z.array(z.string()).default([]),
});

const SignalSchema = z.object({
  enabled: z.boolean().default(false),
  phone: z.string().optional(),
});

const EmailSchema = z.object({
  imap: z.string().default(''),
  smtp: z.string().default(''),
  username: z.string().default(''),
  password: z.string().default(''),
  subject_prefix: z.string().default(''),
  enabled: z.boolean().default(false),
});

const WebchatSchema = z.object({
  enabled: z.boolean().default(true),
});

const ChannelsSchema = z.object({
  telegram: TelegramSchema.default({ token: '', enabled: false }),
  discord: DiscordSchema.default({ token: '', enabled: false }),
  signal: SignalSchema.default({ enabled: false }),
  email: EmailSchema.default({ imap: '', smtp: '', enabled: false }),
  webchat: WebchatSchema.default({ enabled: true }),
});

const McpServerSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  allow_tools: z.array(z.string()).optional(),
  deny_tools: z.array(z.string()).optional(),
});

const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string().optional(),
  system_prompt_file: z.string().optional(),
});

const RecallWeightsSchema = z.object({
  semantic: z.number().default(0.5),
  episodic: z.number().default(0.3),
  recency: z.number().default(0.2),
});

const MemorySchema = z.object({
  consolidation_model: z.string().default('gpt-4o-mini'),
  embedding_model: z.string().default('nomic-embed-text'),
  /**
   * Optional Ollama URL used for embeddings and GPU brokering when the
   * primary LLM provider is a cloud one (openai-codex, anthropic, etc).
   * Lets the orchestrator run in the cloud while skill specialists,
   * vision models, and embeddings stay local on the user's GPU.
   * Falls back to llm.base_url when the LLM provider is itself ollama
   * or lmstudio.
   */
  embedder_base_url: z.string().optional(),
  recall_weights: RecallWeightsSchema.default({ semantic: 0.5, episodic: 0.3, recency: 0.2 }),
});

const CronSchema = z.object({
  enabled: z.boolean().default(true),
});

export const AppConfigSchema = z.object({
  runtime: RuntimeSchema.default({ home_dir: '~/.polymath', port: 18789, log_level: 'info' }),
  llm: LlmSchema.default({ provider: 'openai', model: 'gpt-4o', api_key: '', streaming: true, context_window: 128000, temperature: 0.7 }),
  orchestrator: OrchestratorSchema.default({ max_iterations: 25, max_token_budget: 200000, max_subagent_depth: 3 }),
  sandbox: SandboxSchema.default({ default_mode: 'host', tool_overrides: {} }),
  channels: ChannelsSchema.default({ telegram: { token: '', enabled: false }, discord: { token: '', enabled: false }, signal: { enabled: false }, email: { imap: '', smtp: '', enabled: false }, webchat: { enabled: true } }),
  mcp_servers: z.array(McpServerSchema).default([]),
  agents: z.array(AgentSchema).default([]),
  memory: MemorySchema.default({ consolidation_model: 'gpt-4o-mini', embedding_model: 'nomic-embed-text', recall_weights: { semantic: 0.5, episodic: 0.3, recency: 0.2 } }),
  cron: CronSchema.default({ enabled: true }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
