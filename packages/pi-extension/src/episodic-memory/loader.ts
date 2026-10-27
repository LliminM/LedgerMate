import { selectRelevantMemoryFilenames } from "./selector";
import type { MemorySideQuery } from "./side-query";
import { listMemorySummaries, readMemoryFile } from "./store";
import type { EpisodicMemory } from "./types";

export async function loadRelevantMemories(
  recentConversation: string,
  sideQuery: MemorySideQuery,
  maxItems = 3,
): Promise<EpisodicMemory[]> {
  try {
    const catalog = await listMemorySummaries();
    const filenames = await selectRelevantMemoryFilenames(recentConversation, catalog, sideQuery, maxItems);
    return await Promise.all(filenames.map(readMemoryFile));
  } catch (error) {
    console.error("Episodic memory loading failed:", error);
    return [];
  }
}
