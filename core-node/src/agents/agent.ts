export interface Agent {
  id: string;
  name: string;
  model: string;
  systemPromptFile?: string;
  toolsets?: string[];
}
