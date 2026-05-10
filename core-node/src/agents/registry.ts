import type { Agent } from "./agent.js";

export class AgentRegistry {
  private agents = new Map<string, Agent>();
  private defaultId: string | null = null;

  loadFromConfig(agents: Agent[]): void {
    for (const a of agents) {
      this.agents.set(a.id, a);
      if (!this.defaultId) this.defaultId = a.id;
    }
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  getDefault(): Agent | undefined {
    return this.defaultId ? this.agents.get(this.defaultId) : undefined;
  }
}
