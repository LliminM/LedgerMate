export const EPISODIC_MEMORY_TYPES = ["event", "ongoing", "transaction-context"] as const;

export type EpisodicMemoryType = (typeof EPISODIC_MEMORY_TYPES)[number];

export interface EpisodicMemoryCandidate {
  name: string;
  type: EpisodicMemoryType;
  description: string;
  body: string;
}

export interface EpisodicMemory extends EpisodicMemoryCandidate {
  filename: string;
}

export type EpisodicMemorySummary = Pick<EpisodicMemory, "name" | "type" | "description" | "filename">;

export interface PendingMemoryWrite {
  id: string;
  memory: EpisodicMemoryCandidate;
  filename?: string;
  createdAt: string;
  attempts: number;
  lastError: string;
}

export interface DeleteEpisodicMemoryResult {
  name: string;
  deleted: boolean;
}
