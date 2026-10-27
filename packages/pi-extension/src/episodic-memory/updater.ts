import { serializeMemoryMarkdown } from "./frontmatter";
import { parseUpdatedMemory } from "./json-response";
import { buildUpdateMemoryPrompt, UPDATE_MEMORY_SYSTEM_PROMPT } from "./prompts";
import type { MemorySideQuery } from "./side-query";
import type { EpisodicMemory, EpisodicMemoryCandidate } from "./types";

export async function updateExistingMemory(
  existing: EpisodicMemory,
  candidate: EpisodicMemoryCandidate,
  conversation: string,
  sideQuery: MemorySideQuery,
): Promise<EpisodicMemoryCandidate | undefined> {
  const response = await sideQuery.complete(
    UPDATE_MEMORY_SYSTEM_PROMPT,
    buildUpdateMemoryPrompt(serializeMemoryMarkdown(existing), candidate, conversation),
    1_000,
  );
  const updated = parseUpdatedMemory(response);
  if (updated && updated.name !== existing.name) {
    throw new Error(`Memory updater changed the stable name from ${existing.name} to ${updated.name}`);
  }
  return updated;
}
