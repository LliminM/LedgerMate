// The ordered list of workspace migrations (see runner.ts for the rules) and
// the launch-time entry point. Append new migrations at the end.

import { homedir } from "node:os";
import { workspaceDir } from "../env";
import { relocateLegacyHome } from "./0001-relocate-legacy-home";
import { ignoreChromaIndex } from "./0002-ignore-chroma-index";
import { ignoreAgentTraces } from "./0003-ignore-agent-traces";
import { createEpisodicMemories } from "./0004-create-episodic-memories";
import { type Migration, runMigrations } from "./runner";

export const MIGRATIONS: readonly Migration[] = [
  relocateLegacyHome,
  ignoreChromaIndex,
  ignoreAgentTraces,
  createEpisodicMemories,
];

/** Run the migrations the active workspace has not seen yet. */
export function runPendingMigrations(): Promise<string[]> {
  return runMigrations(MIGRATIONS, { workspaceDir: workspaceDir(), homeDir: homedir() });
}
