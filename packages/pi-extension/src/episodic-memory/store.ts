import { randomUUID } from "node:crypto";
import { type Dirent, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { EPISODIC_MEMORY_DIR, EPISODIC_MEMORY_INDEX_PATH } from "../config";
import { parseMemoryMarkdown, serializeMemoryMarkdown } from "./frontmatter";
import { buildMemoryIndex } from "./index-file";
import { collisionFilenameForMemoryName, filenameForMemoryName, isSafeMemoryFilename, memoryFilePath } from "./paths";
import type { EpisodicMemory, EpisodicMemoryCandidate, EpisodicMemorySummary } from "./types";

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(EPISODIC_MEMORY_DIR, { recursive: true });
  const temporary = join(EPISODIC_MEMORY_DIR, `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readMemoryFile(filename: string): Promise<EpisodicMemory> {
  const markdown = await readFile(memoryFilePath(filename), "utf8");
  return { ...parseMemoryMarkdown(markdown), filename };
}

export async function listMemories(): Promise<EpisodicMemory[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(EPISODIC_MEMORY_DIR, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const memories: EpisodicMemory[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isSafeMemoryFilename(entry.name)) continue;
    try {
      memories.push(await readMemoryFile(entry.name));
    } catch {
      // A malformed hand-edited file is excluded from the catalog so it can
      // never be injected as trusted memory. Other valid files still load.
    }
  }
  return memories.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listMemorySummaries(): Promise<EpisodicMemorySummary[]> {
  return (await listMemories()).map(({ name, type, description, filename }) => ({
    name,
    type,
    description,
    filename,
  }));
}

export async function findMemoryByName(name: string): Promise<EpisodicMemory | undefined> {
  return (await listMemories()).find((memory) => memory.name === name);
}

async function filenameForNewMemory(name: string): Promise<string> {
  const preferred = filenameForMemoryName(name);
  if (!existsSync(memoryFilePath(preferred))) return preferred;

  try {
    const existing = await readMemoryFile(preferred);
    if (existing.name === name) return preferred;
  } catch {
    // A collision with an invalid file must not overwrite the user's data.
  }
  return collisionFilenameForMemoryName(name);
}

export async function rebuildMemoryIndex(): Promise<void> {
  await atomicWrite(EPISODIC_MEMORY_INDEX_PATH, buildMemoryIndex(await listMemorySummaries()));
}

export async function writeMemory(memory: EpisodicMemoryCandidate, filename?: string): Promise<EpisodicMemory> {
  const target = filename ?? (await filenameForNewMemory(memory.name));
  if (!isSafeMemoryFilename(target)) throw new Error(`Unsafe episodic memory filename: ${target}`);

  await atomicWrite(memoryFilePath(target), serializeMemoryMarkdown(memory));
  await rebuildMemoryIndex();
  return { ...memory, filename: target };
}

export async function deleteMemoryByName(name: string): Promise<boolean> {
  const memory = await findMemoryByName(name);
  if (!memory) return false;
  await unlink(memoryFilePath(memory.filename));
  await rebuildMemoryIndex();
  return true;
}
