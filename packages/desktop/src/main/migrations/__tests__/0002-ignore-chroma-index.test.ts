import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHROMA_IGNORE_ENTRY, ignoreChromaIndex } from "../0002-ignore-chroma-index";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "a24-chroma-migration-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const run = () => ignoreChromaIndex.run({ workspaceDir: workspace, homeDir: path.dirname(workspace) });

describe("0002-ignore-chroma-index", () => {
  it("should carry the id recorded by the migration runner", () => {
    expect(ignoreChromaIndex.id).toBe("0002-ignore-chroma-index");
  });

  it("should append the Chroma data directory to an existing gitignore", async () => {
    writeFileSync(path.join(workspace, ".gitignore"), "auth.json\nsessions/\n");
    await run();
    expect(readFileSync(path.join(workspace, ".gitignore"), "utf8")).toBe(
      `auth.json\nsessions/\n${CHROMA_IGNORE_ENTRY}\n`,
    );
  });

  it("should add a separating newline when the existing file has none", async () => {
    writeFileSync(path.join(workspace, ".gitignore"), "auth.json");
    await run();
    expect(readFileSync(path.join(workspace, ".gitignore"), "utf8")).toBe(`auth.json\n${CHROMA_IGNORE_ENTRY}\n`);
  });

  it("should write only the entry when the existing file is empty", async () => {
    writeFileSync(path.join(workspace, ".gitignore"), "");
    await run();
    expect(readFileSync(path.join(workspace, ".gitignore"), "utf8")).toBe(`${CHROMA_IGNORE_ENTRY}\n`);
  });

  it("should be idempotent when the entry is already present", async () => {
    const content = `auth.json\n${CHROMA_IGNORE_ENTRY}\n`;
    writeFileSync(path.join(workspace, ".gitignore"), content);
    await run();
    await run();
    expect(readFileSync(path.join(workspace, ".gitignore"), "utf8")).toBe(content);
  });

  it("should leave a fresh workspace without a gitignore untouched", async () => {
    rmSync(workspace, { recursive: true });
    await run();
    expect(() => readFileSync(path.join(workspace, ".gitignore"), "utf8")).toThrow();
  });

  it("should not treat a similar nested pattern as the required entry", async () => {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, ".gitignore"), "backup/rag/chroma/\n");
    await run();
    expect(readFileSync(path.join(workspace, ".gitignore"), "utf8")).toBe(
      `backup/rag/chroma/\n${CHROMA_IGNORE_ENTRY}\n`,
    );
  });
});
