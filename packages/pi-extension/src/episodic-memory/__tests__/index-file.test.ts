import { describe, expect, it } from "vitest";
import { buildMemoryIndex, EMPTY_MEMORY_INDEX } from "../index-file";

describe("buildMemoryIndex()", () => {
  it("should return only the heading when no memories exist", () => {
    expect(buildMemoryIndex([])).toBe(EMPTY_MEMORY_INDEX);
  });

  it("should list each name, filename, and one-line description", () => {
    expect(
      buildMemoryIndex([
        {
          name: "ZARA [coat]",
          type: "transaction-context",
          description: "Bought in Hangzhou\nfor CNY 100",
          filename: "zara-coat.md",
        },
      ]),
    ).toBe("# Episodic memories\n\n- [ZARA \\[coat\\]](zara-coat.md) — Bought in Hangzhou for CNY 100\n");
  });
});
