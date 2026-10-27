import { parseMemoryCandidates } from "./json-response";
import { buildExtractMemoriesPrompt, EXTRACT_MEMORIES_SYSTEM_PROMPT } from "./prompts";
import type { MemorySideQuery } from "./side-query";
import type { EpisodicMemoryCandidate, EpisodicMemorySummary } from "./types";

export async function extractMemoryCandidates(
  conversation: string,
  catalog: EpisodicMemorySummary[],
  deletedNames: string[],
  sideQuery: MemorySideQuery,
): Promise<EpisodicMemoryCandidate[]> {
  const response = await sideQuery.complete(
    EXTRACT_MEMORIES_SYSTEM_PROMPT,
    buildExtractMemoriesPrompt(conversation, catalog, deletedNames),
    1_200,
  );
  return parseMemoryCandidates(response);
}
