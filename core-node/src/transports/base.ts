export interface Transport {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(sessionId: string, text: string): Promise<void>;
}
