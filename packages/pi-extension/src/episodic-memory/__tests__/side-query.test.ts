import { describe, expect, it, vi } from "vitest";
import { createMemorySideQuery } from "../side-query";

function response(stopReason: "stop" | "error" | "aborted" = "stop") {
  return {
    content: [
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: '["coat.md"]' },
    ],
    stopReason,
    errorMessage: stopReason === "error" ? "provider failed" : undefined,
  };
}

describe("createMemorySideQuery()", () => {
  it("should return undefined when no model is selected", () => {
    expect(createMemorySideQuery({ model: undefined, modelRegistry: {} as never })).toBeUndefined();
  });

  it("should make an isolated low-token completion and return text only", async () => {
    const complete = vi.fn().mockResolvedValue(response());
    const model = { id: "test-model" } as never;
    const query = createMemorySideQuery({ model, modelRegistry: { complete } as never });

    await expect(query?.complete("system", "prompt", 200)).resolves.toBe('["coat.md"]');
    expect(complete).toHaveBeenCalledWith(
      model,
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "prompt", timestamp: expect.any(Number) }],
      },
      { maxTokens: 200, cacheRetention: "none", sessionId: expect.any(String) },
    );
  });

  it("should reject provider errors", async () => {
    const query = createMemorySideQuery({
      model: { id: "test-model" } as never,
      modelRegistry: { complete: vi.fn().mockResolvedValue(response("error")) } as never,
    });
    await expect(query?.complete("system", "prompt", 200)).rejects.toThrow("provider failed");
  });
});
