import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEpisodicMemories,
  EPISODIC_MEMORY_IGNORE_ENTRIES,
  EPISODIC_MEMORY_INDEX,
} from "../0004-create-episodic-memories";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "a24-episodic-memory-migration-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const run = () => createEpisodicMemories.run({ workspaceDir: workspace, homeDir: path.dirname(workspace) });

describe("0004-create-episodic-memories", () => {
  it("should carry the id recorded by the migration runner", () => {
    expect(createEpisodicMemories.id).toBe("0004-create-episodic-memories");
  });

  it("should create the memory directory and empty catalog", async () => {
    await run();

    const index = path.join(workspace, "memories", "MEMORY.md");
    expect(existsSync(index)).toBe(true);
    expect(readFileSync(index, "utf8")).toBe(EPISODIC_MEMORY_INDEX);
  });

  it("should preserve an existing catalog", async () => {
    const directory = path.join(workspace, "memories");
    await run();
    writeFileSync(path.join(directory, "MEMORY.md"), "custom catalog\n");

    await run();

    expect(readFileSync(path.join(directory, "MEMORY.md"), "utf8")).toBe("custom catalog\n");
  });

  it("should append operational-file ignores to an existing gitignore", async () => {
    writeFileSync(path.join(workspace, ".gitignore"), "auth.json\n");

    await run();

    expect(readFileSync(path.join(workspace, ".gitignore"), "utf8")).toBe(
      `auth.json\n${EPISODIC_MEMORY_IGNORE_ENTRIES.join("\n")}\n`,
    );
  });

  it("should be idempotent", async () => {
    writeFileSync(path.join(workspace, ".gitignore"), "auth.json");

    await run();
    const firstIndex = readFileSync(path.join(workspace, "memories", "MEMORY.md"), "utf8");
    const firstIgnore = readFileSync(path.join(workspace, ".gitignore"), "utf8");
    await run();

    expect(readFileSync(path.join(workspace, "memories", "MEMORY.md"), "utf8")).toBe(firstIndex);
    expect(readFileSync(path.join(workspace, ".gitignore"), "utf8")).toBe(firstIgnore);
  });
});
