import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { EPISODIC_MEMORY_DIR, EPISODIC_MEMORY_PENDING_PATH } from "../config";
import { writeMemory } from "./store";
import type { EpisodicMemory, EpisodicMemoryCandidate, PendingMemoryWrite } from "./types";

type MemoryWriter = (memory: EpisodicMemoryCandidate, filename?: string) => Promise<EpisodicMemory>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readPendingWrites(): Promise<PendingMemoryWrite[]> {
  try {
    const parsed = JSON.parse(await readFile(EPISODIC_MEMORY_PENDING_PATH, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("Pending episodic memory writes must be a JSON array");
    return parsed as PendingMemoryWrite[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writePendingWrites(writes: PendingMemoryWrite[]): Promise<void> {
  if (writes.length === 0) {
    await rm(EPISODIC_MEMORY_PENDING_PATH, { force: true });
    return;
  }

  await mkdir(EPISODIC_MEMORY_DIR, { recursive: true });
  const temporary = join(EPISODIC_MEMORY_DIR, `.${basename(EPISODIC_MEMORY_PENDING_PATH)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(writes, null, 2)}\n`, "utf8");
    await rename(temporary, EPISODIC_MEMORY_PENDING_PATH);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function recordPendingWrite(
  memory: EpisodicMemoryCandidate,
  filename: string | undefined,
  error: unknown,
): Promise<void> {
  const pending = await readPendingWrites();
  const previous = pending.find((item) => item.memory.name === memory.name);
  const replacement: PendingMemoryWrite = {
    id: previous?.id ?? randomUUID(),
    memory,
    filename,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    attempts: (previous?.attempts ?? 0) + 1,
    lastError: errorMessage(error),
  };
  await writePendingWrites([...pending.filter((item) => item.memory.name !== memory.name), replacement]);
}

export interface RetryPendingWritesResult {
  succeeded: number;
  failed: number;
}

export async function retryPendingWrites(writer: MemoryWriter = writeMemory): Promise<RetryPendingWritesResult> {
  const pending = await readPendingWrites();
  const remaining: PendingMemoryWrite[] = [];
  let succeeded = 0;

  for (const item of pending) {
    try {
      await writer(item.memory, item.filename);
      succeeded++;
    } catch (error) {
      remaining.push({ ...item, attempts: item.attempts + 1, lastError: errorMessage(error) });
    }
  }

  await writePendingWrites(remaining);
  return { succeeded, failed: remaining.length };
}
