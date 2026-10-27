// Agent traces are local diagnostics and can contain sensitive operational
// metadata. Keep them in the workspace for inspection/export, but never commit
// them to the workspace Git repository by default.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Migration } from "./runner";

export const TRACES_IGNORE_ENTRY = "traces/";

export const ignoreAgentTraces: Migration = {
  id: "0003-ignore-agent-traces",
  run({ workspaceDir }) {
    const gitignore = path.join(workspaceDir, ".gitignore");
    // Fresh workspaces receive the current template after migrations finish.
    if (!existsSync(gitignore)) return;

    const current = readFileSync(gitignore, "utf8");
    if (current.split(/\r?\n/).includes(TRACES_IGNORE_ENTRY)) return;

    const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    writeFileSync(gitignore, `${current}${separator}${TRACES_IGNORE_ENTRY}\n`);
  },
};
