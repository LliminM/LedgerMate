import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setBaseDir } from "../../config";
import { writeMemory } from "../../episodic-memory/store";
import { createDeleteEpisodicMemoryTool, deleteEpisodicMemoryTool } from "../delete-episodic-memory";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-delete-memory-tool-"));

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
  setBaseDir(BASE);
});

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

const execute = (tool: ReturnType<typeof createDeleteEpisodicMemoryTool>, name: string) =>
  tool.execute("call-1", { name }, new AbortController().signal, () => {}, undefined as never);

describe("deleteEpisodicMemoryTool", () => {
  it("should delete the exact requested name", async () => {
    const remove = vi.fn().mockResolvedValue(true);
    const tool = createDeleteEpisodicMemoryTool(remove);

    const result = await execute(tool, "zara-coat");

    expect(remove).toHaveBeenCalledWith("zara-coat");
    expect(result).toEqual({
      content: [{ type: "text", text: "Deleted episodic memory: zara-coat" }],
      details: { name: "zara-coat", deleted: true },
    });
  });

  it("should report a missing exact name without claiming deletion", async () => {
    const tool = createDeleteEpisodicMemoryTool(vi.fn().mockResolvedValue(false));
    const result = await execute(tool, "missing");
    expect(result.content).toEqual([{ type: "text", text: "No episodic memory exists with the exact name: missing" }]);
    expect(result.details).toEqual({ name: "missing", deleted: false });
  });

  it("should use the serialized default store deletion", async () => {
    await writeMemory({ name: "trip", type: "event", description: "A trip", body: "Visited Hangzhou." });
    const result = await execute(deleteEpisodicMemoryTool, "trip");
    expect(result.details).toEqual({ name: "trip", deleted: true });
  });
});
