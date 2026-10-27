import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { EPISODIC_MEMORY_DIR } from "../config";

const MAX_SLUG_LENGTH = 80;

export function slugifyMemoryName(name: string): string {
  const slug = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");

  if (!slug) return "episode";
  return slug === "memory" ? "memory-entry" : slug;
}

export function filenameForMemoryName(name: string): string {
  return `${slugifyMemoryName(name)}.md`;
}

export function collisionFilenameForMemoryName(name: string): string {
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${slugifyMemoryName(name)}-${digest}.md`;
}

export function isSafeMemoryFilename(filename: string): boolean {
  return (
    filename === basename(filename) &&
    filename.toLowerCase().endsWith(".md") &&
    filename.toLowerCase() !== "memory.md" &&
    !filename.startsWith(".")
  );
}

export function memoryFilePath(filename: string): string {
  if (!isSafeMemoryFilename(filename)) throw new Error(`Unsafe episodic memory filename: ${filename}`);
  return join(EPISODIC_MEMORY_DIR, filename);
}
