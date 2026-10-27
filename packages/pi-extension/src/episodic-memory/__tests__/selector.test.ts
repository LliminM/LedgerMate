import { describe, expect, it, vi } from "vitest";
import { selectRelevantMemoryFilenames } from "../selector";

const catalog = [
  { name: "coat", type: "transaction-context" as const, description: "ZARA coat in Hangzhou", filename: "coat.md" },
  { name: "trip", type: "event" as const, description: "Business trip to Beijing", filename: "trip.md" },
  { name: "repair", type: "ongoing" as const, description: "Laptop repair", filename: "repair.md" },
  { name: "move", type: "event" as const, description: "Moved apartments", filename: "move.md" },
];

describe("selectRelevantMemoryFilenames()", () => {
  it("should ask the side-query and keep exact catalog filenames", async () => {
    const complete = vi.fn().mockResolvedValue('["coat.md"]');

    await expect(
      selectRelevantMemoryFilenames("User asks where the ZARA coat was bought", catalog, { complete }),
    ).resolves.toEqual(["coat.md"]);

    expect(complete).toHaveBeenCalledWith(
      expect.stringContaining("exact filenames"),
      expect.stringContaining("coat.md | coat | transaction-context | ZARA coat in Hangzhou"),
      200,
    );
  });

  it("should discard invented filenames and duplicates", async () => {
    const complete = vi.fn().mockResolvedValue('["missing.md", "coat.md", "coat.md"]');
    await expect(selectRelevantMemoryFilenames("coat", catalog, { complete })).resolves.toEqual(["coat.md"]);
  });

  it("should enforce the maximum after validation", async () => {
    const complete = vi.fn().mockResolvedValue('["coat.md", "trip.md", "repair.md", "move.md"]');
    await expect(selectRelevantMemoryFilenames("everything", catalog, { complete }, 3)).resolves.toEqual([
      "coat.md",
      "trip.md",
      "repair.md",
    ]);
  });

  it("should skip the side-query for an empty catalog", async () => {
    const complete = vi.fn();
    await expect(selectRelevantMemoryFilenames("coat", [], { complete })).resolves.toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });
});
