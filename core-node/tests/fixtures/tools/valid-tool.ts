import { z } from "zod";

export function register(registry) {
  registry.register({
    name: "fixture.valid",
    description: "a valid fixture tool",
    parameters: z.object({}),
    handler: async () => "hello",
  });
}
