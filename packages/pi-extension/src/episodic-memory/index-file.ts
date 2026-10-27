import type { EpisodicMemorySummary } from "./types";

export const EMPTY_MEMORY_INDEX = "# Episodic memories\n";

function escapeLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

export function buildMemoryIndex(memories: EpisodicMemorySummary[]): string {
  if (memories.length === 0) return EMPTY_MEMORY_INDEX;
  const lines = memories.map(
    (memory) => `- [${escapeLabel(memory.name)}](${memory.filename}) — ${memory.description.replace(/\s+/g, " ")}`,
  );
  return `${EMPTY_MEMORY_INDEX}\n${lines.join("\n")}\n`;
}
