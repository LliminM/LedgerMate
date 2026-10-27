import { parseSelectedFilenames } from "./json-response";
import { buildSelectMemoriesPrompt, SELECT_MEMORIES_SYSTEM_PROMPT } from "./prompts";
import type { MemorySideQuery } from "./side-query";
import type { EpisodicMemorySummary } from "./types";

export async function selectRelevantMemoryFilenames(
  recentConversation: string,
  catalog: EpisodicMemorySummary[],
  sideQuery: MemorySideQuery,
  maxItems = 3,
): Promise<string[]> {
  if (catalog.length === 0 || maxItems <= 0) return [];

  const response = await sideQuery.complete(
    SELECT_MEMORIES_SYSTEM_PROMPT,
    buildSelectMemoriesPrompt(recentConversation, catalog, maxItems),
    200,
  );
  const allowed = new Set(catalog.map((memory) => memory.filename));
  const selected: string[] = [];
  for (const filename of parseSelectedFilenames(response)) {
    if (allowed.has(filename) && !selected.includes(filename)) selected.push(filename);
    if (selected.length === maxItems) break;
  }
  return selected;
}
