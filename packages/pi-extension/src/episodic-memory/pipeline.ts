import { extractMemoryCandidates } from "./extractor";
import { recordPendingWrite } from "./pending-writes";
import type { MemorySideQuery } from "./side-query";
import { listMemories, writeMemory } from "./store";
import type { EpisodicMemoryCandidate } from "./types";
import { updateExistingMemory } from "./updater";

export interface MemoryExtractionResult {
  candidates: number;
  written: number;
  unchanged: number;
  queuedForRetry: number;
}

function deduplicateByName(candidates: EpisodicMemoryCandidate[]): EpisodicMemoryCandidate[] {
  const unique = new Map<string, EpisodicMemoryCandidate>();
  for (const candidate of candidates) unique.set(candidate.name, candidate);
  return [...unique.values()];
}

export async function extractAndPersistMemories(
  conversation: string,
  deletedNames: string[],
  sideQuery: MemorySideQuery,
): Promise<MemoryExtractionResult> {
  const existing = await listMemories();
  const catalog = existing.map(({ name, type, description, filename }) => ({ name, type, description, filename }));
  const extracted = deduplicateByName(
    await extractMemoryCandidates(conversation, catalog, deletedNames, sideQuery),
  ).filter((candidate) => !deletedNames.includes(candidate.name));

  const byName = new Map(existing.map((memory) => [memory.name, memory]));
  let written = 0;
  let unchanged = 0;
  let queuedForRetry = 0;

  for (const candidate of extracted) {
    const oldMemory = byName.get(candidate.name);
    let nextMemory = candidate;
    let filename: string | undefined;

    if (oldMemory) {
      filename = oldMemory.filename;
      try {
        const updated = await updateExistingMemory(oldMemory, candidate, conversation, sideQuery);
        if (!updated) {
          unchanged++;
          continue;
        }
        nextMemory = updated;
      } catch (error) {
        console.error(`Episodic memory update failed for ${candidate.name}:`, error);
        continue;
      }
    }

    try {
      const saved = await writeMemory(nextMemory, filename);
      byName.set(saved.name, saved);
      written++;
    } catch (error) {
      try {
        await recordPendingWrite(nextMemory, filename, error);
        queuedForRetry++;
      } catch (pendingError) {
        console.error(`Episodic memory write and retry recording failed for ${candidate.name}:`, {
          writeError: error,
          pendingError,
        });
      }
    }
  }

  return { candidates: extracted.length, written, unchanged, queuedForRetry };
}
