import { describe, it, expect, vi } from "vitest";

// Mock auth_refresh so constructing/using the OpenAiCodexAdapter never
// touches the real token store on disk. The factory test only exercises
// adapter selection — it shouldn't kick off a refresh either.
vi.mock("../src/llm/codex/auth_refresh.js", () => ({
  ensureFreshToken: vi.fn().mockResolvedValue({
    access_token: "test-access",
    id_token: "test-id",
    refresh_token: "test-refresh",
    account_id: "acct_test",
  }),
  forceRefresh: vi.fn(),
}));

import { buildLlm } from "../src/main.js";
import { OpenAiCodexAdapter } from "../src/llm/codex/responses_adapter.js";
import { OpenAiAdapter } from "../src/llm/openai.js";
import { AnthropicAdapter } from "../src/llm/anthropic.js";

describe("buildLlm factory dispatch", () => {
  it("returns OpenAiCodexAdapter when provider is 'openai-codex'", () => {
    const adapter = buildLlm({
      provider: "openai-codex",
      model: "gpt-5.5",
      streaming: true,
    });
    expect(adapter).toBeInstanceOf(OpenAiCodexAdapter);
    // Account id is null until the first call resolves a token; this
    // confirms the adapter wasn't accidentally pre-warmed in the factory.
    expect((adapter as OpenAiCodexAdapter).getAccountId()).toBeNull();
  });

  it("returns OpenAiAdapter for the default 'openai' provider", () => {
    const adapter = buildLlm({
      provider: "openai",
      api_key: "sk-x",
      model: "gpt-4o",
      streaming: true,
    });
    expect(adapter).toBeInstanceOf(OpenAiAdapter);
    expect(adapter).not.toBeInstanceOf(OpenAiCodexAdapter);
  });

  it("returns AnthropicAdapter when provider is 'anthropic'", () => {
    const adapter = buildLlm({
      provider: "anthropic",
      api_key: "sk-ant-x",
      model: "claude-sonnet-4",
      streaming: true,
    });
    expect(adapter).toBeInstanceOf(AnthropicAdapter);
  });

  it("falls back to OpenAiAdapter for unknown openai-compatible providers", () => {
    const adapter = buildLlm({
      provider: "ollama",
      model: "llama3.1",
      streaming: false,
    });
    expect(adapter).toBeInstanceOf(OpenAiAdapter);
  });
});
