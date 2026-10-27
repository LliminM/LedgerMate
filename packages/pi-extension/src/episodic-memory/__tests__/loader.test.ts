import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setBaseDir } from "../../config";
import { loadRelevantMemories } from "../loader";
import { writeMemory } from "../store";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-episodic-loader-"));

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
  setBaseDir(BASE);
});

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

describe("loadRelevantMemories()", () => {
  it("should return only files selected by the side-query", async () => {
    await writeMemory({ name: "coat", type: "event", description: "A coat", body: "Bought in Hangzhou." });
    await writeMemory({ name: "trip", type: "event", description: "A trip", body: "Visited Beijing." });

    const result = await loadRelevantMemories("Where was the coat bought?", {
      complete: vi.fn().mockResolvedValue('["coat.md"]'),
    });

    expect(result).toEqual([expect.objectContaining({ name: "coat", body: "Bought in Hangzhou." })]);
  });

  it("should fail soft when selection cannot be parsed", async () => {
    await writeMemory({ name: "coat", type: "event", description: "A coat", body: "Bought in Hangzhou." });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      loadRelevantMemories("Where was the coat bought?", { complete: vi.fn().mockResolvedValue("not json") }),
    ).resolves.toEqual([]);
    expect(error).toHaveBeenCalledWith("Episodic memory loading failed:", expect.any(Error));
    error.mockRestore();
  });
});
