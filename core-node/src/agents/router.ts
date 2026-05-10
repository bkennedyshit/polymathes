import type { Agent } from "./agent.js";
import type { AgentRegistry } from "./registry.js";

export function routeMessage(
  _channel: string,
  _senderId: string,
  _text: string,
  registry: AgentRegistry,
): Agent | undefined {
  // v1: always return default agent. Routing logic is v1.1.
  return registry.getDefault();
}
