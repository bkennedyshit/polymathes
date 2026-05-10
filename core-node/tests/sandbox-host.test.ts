import { describe, it, expect } from "vitest";
import { hostExecute } from "../src/sandbox/host.js";

describe("hostExecute", () => {
  it("calls handler and returns result", async () => {
    const result = await hostExecute(async (args) => args, { x: 1 }, {});
    expect(result).toEqual({ x: 1 });
  });

  it("throws if signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(hostExecute(async () => "x", {}, {}, controller.signal)).rejects.toThrow("aborted");
  });
});
