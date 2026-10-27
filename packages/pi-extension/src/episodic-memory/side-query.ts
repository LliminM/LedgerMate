import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface MemorySideQuery {
  complete(systemPrompt: string, prompt: string, maxTokens: number): Promise<string>;
}

export function createMemorySideQuery(
  context: Pick<ExtensionContext, "model" | "modelRegistry">,
): MemorySideQuery | undefined {
  const model = context.model;
  if (!model) return undefined;

  return {
    async complete(systemPrompt, prompt, maxTokens) {
      const response = await context.modelRegistry.complete(
        model,
        {
          systemPrompt,
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        },
        { maxTokens, cacheRetention: "none", sessionId: randomUUID() },
      );

      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage ?? `Memory side-query stopped: ${response.stopReason}`);
      }

      return response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
    },
  };
}
