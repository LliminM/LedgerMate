// Episodic memory is stored as one Markdown file per remembered situation.
// Existing workspaces need the directory and generated catalog that fresh
// workspaces receive from the scaffold.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Migration } from "./runner";

export const EPISODIC_MEMORY_INDEX = "# Episodic memories\n";
export const EPISODIC_MEMORY_IGNORE_ENTRIES = ["memories/.pending-writes.json", "memories/.*.tmp"] as const;

function addIgnoreEntries(workspaceDir: string): void {
  const gitignore = path.join(workspaceDir, ".gitignore");
  if (!existsSync(gitignore)) return;

  const current = readFileSync(gitignore, "utf8");
  const lines = new Set(current.split(/\r?\n/));
  const missing = EPISODIC_MEMORY_IGNORE_ENTRIES.filter((entry) => !lines.has(entry));
  if (missing.length === 0) return;

  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  writeFileSync(gitignore, `${current}${separator}${missing.join("\n")}\n`);
}

export const createEpisodicMemories: Migration = {
  id: "0004-create-episodic-memories",
  run({ workspaceDir }) {
    const directory = path.join(workspaceDir, "memories");
    mkdirSync(directory, { recursive: true });

    const index = path.join(directory, "MEMORY.md");
    if (!existsSync(index)) writeFileSync(index, EPISODIC_MEMORY_INDEX);

    addIgnoreEntries(workspaceDir);
  },
};
