import { describe, expect, it, vi } from "vitest";
import { updateExistingMemory } from "../updater";

const existing = {
  name: "trip",
  type: "event" as const,
  description: "A trip",
  body: "The user visited Hangzhou.",
  filename: "trip.md",
};

describe("updateExistingMemory()", () => {
  it("should reject an updater response that changes the stable name", async () => {
    const complete = vi.fn().mockResolvedValue('{"name":"new-name","type":"event","description":"Trip","body":"Body"}');

    await expect(updateExistingMemory(existing, existing, "turn", { complete })).rejects.toThrow(
      "changed the stable name",
    );
  });

  it("should include the complete old file and current evidence in the rewrite request", async () => {
    const complete = vi.fn().mockResolvedValue("null");
    await updateExistingMemory(existing, existing, "The city was corrected.", { complete });
    expect(complete).toHaveBeenCalledWith(
      expect.stringContaining("latest explicit correction"),
      expect.stringContaining("<existing_memory>\n---\nname: trip"),
      1_000,
    );
    expect(complete.mock.calls[0][1]).toContain("The city was corrected.");
  });
});
