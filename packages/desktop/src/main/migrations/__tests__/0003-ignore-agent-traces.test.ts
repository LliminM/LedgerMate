import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ignoreAgentTraces, TRACES_IGNORE_ENTRY } from "../0003-ignore-agent-traces";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "a24-traces-migration-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const run = () => ignoreAgentTraces.run({ workspaceDir: workspace, homeDir: path.dirname(workspace) });

describe("0003-ignore-agent-traces", () => {
  it("should carry the id recorded by the migration runner", () => {
    expect(ignoreAgentTraces.id).toBe("0003-ignore-agent-traces");
  });

  it("should append the traces directory to an existing gitignore", async () => {
    writeFileSync(path.join(workspace, ".gitignore"), "auth.json\nsessions/\n");
    await run();
    expect(readFileSync(path.join(workspace, ".gitignore"), "utf8")).toBe(
      `auth.json\nsessions/\n${TRACES_IGNORE_ENTRY}\n`,
    );
  });

  it("should add a separating newline when the existing file has none", async () => {
    writeFileSync(path.join(workspace, ".gitignore"), "auth.json");
    await run();
    expect(readFileSync(path.join(workspace, ".gitignore"), "utf8")).toBe(`auth.json\n${TRACES_IGNORE_ENTRY}\n`);
  });

  it("should be idempotent when the entry is already present", async () => {
    const content = `auth.json\n${TRACES_IGNORE_ENTRY}\n`;
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
});
