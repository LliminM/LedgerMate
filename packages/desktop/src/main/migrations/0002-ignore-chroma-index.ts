// Chroma's local database is a rebuildable index rather than source data. Keep
// it in the workspace so backups remain self-contained, but never commit its
// binary files to the workspace git repository.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Migration } from "./runner";

export const CHROMA_IGNORE_ENTRY = "rag/chroma/";

export const ignoreChromaIndex: Migration = {
  id: "0002-ignore-chroma-index",
  run({ workspaceDir }) {
    const gitignore = path.join(workspaceDir, ".gitignore");
    // Fresh workspaces receive the current template after migrations finish.
    if (!existsSync(gitignore)) return;

    const current = readFileSync(gitignore, "utf8");
    if (current.split(/\r?\n/).includes(CHROMA_IGNORE_ENTRY)) return;

    const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    writeFileSync(gitignore, `${current}${separator}${CHROMA_IGNORE_ENTRY}\n`);
  },
};
