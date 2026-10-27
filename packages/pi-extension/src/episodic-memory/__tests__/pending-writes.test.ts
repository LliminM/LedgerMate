import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EPISODIC_MEMORY_PENDING_PATH, setBaseDir } from "../../config";
import { recordPendingWrite, retryPendingWrites } from "../pending-writes";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-pending-memory-"));
const memory = { name: "coat", type: "event" as const, description: "A coat", body: "Bought in Hangzhou." };

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
  setBaseDir(BASE);
});

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

describe("recordPendingWrite()", () => {
  it("should persist the extracted memory and error for retry", async () => {
    await recordPendingWrite(memory, "coat.md", new Error("disk full"));
    const pending = JSON.parse(readFileSync(EPISODIC_MEMORY_PENDING_PATH, "utf8"));
    expect(pending).toEqual([
      expect.objectContaining({
        memory,
        filename: "coat.md",
        attempts: 1,
        lastError: "disk full",
        id: expect.any(String),
        createdAt: expect.any(String),
      }),
    ]);
  });

  it("should replace an older pending version of the same named memory", async () => {
    await recordPendingWrite(memory, undefined, "first");
    await recordPendingWrite({ ...memory, body: "Corrected body." }, undefined, "second");
    const pending = JSON.parse(readFileSync(EPISODIC_MEMORY_PENDING_PATH, "utf8"));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(expect.objectContaining({ attempts: 2, lastError: "second" }));
    expect(pending[0].memory.body).toBe("Corrected body.");
  });
});

describe("retryPendingWrites()", () => {
  it("should remove the queue file after all retries succeed", async () => {
    await recordPendingWrite(memory, "coat.md", "disk full");
    const writer = vi.fn().mockResolvedValue({ ...memory, filename: "coat.md" });

    await expect(retryPendingWrites(writer)).resolves.toEqual({ succeeded: 1, failed: 0 });
    expect(writer).toHaveBeenCalledWith(memory, "coat.md");
    expect(existsSync(EPISODIC_MEMORY_PENDING_PATH)).toBe(false);
  });

  it("should retain failed writes with an incremented attempt count", async () => {
    await recordPendingWrite(memory, undefined, "disk full");

    await expect(retryPendingWrites(vi.fn().mockRejectedValue(new Error("still full")))).resolves.toEqual({
      succeeded: 0,
      failed: 1,
    });

    const pending = JSON.parse(readFileSync(EPISODIC_MEMORY_PENDING_PATH, "utf8"));
    expect(pending[0]).toEqual(expect.objectContaining({ attempts: 2, lastError: "still full" }));
  });

  it("should do nothing when no queue exists", async () => {
    const writer = vi.fn();
    await expect(retryPendingWrites(writer)).resolves.toEqual({ succeeded: 0, failed: 0 });
    expect(writer).not.toHaveBeenCalled();
  });

  it("should reject a malformed retry queue", async () => {
    mkdirSync(join(BASE, "memories"), { recursive: true });
    writeFileSync(EPISODIC_MEMORY_PENDING_PATH, "{}");
    await expect(retryPendingWrites()).rejects.toThrow("must be a JSON array");
  });

  it("should clean up its temporary file when rewriting the queue fails", async () => {
    await recordPendingWrite(memory, undefined, "disk full");
    const writer = vi.fn().mockImplementation(async () => {
      rmSync(EPISODIC_MEMORY_PENDING_PATH);
      mkdirSync(EPISODIC_MEMORY_PENDING_PATH);
      throw new Error("still full");
    });

    await expect(retryPendingWrites(writer)).rejects.toThrow();

    expect(readdirSync(join(BASE, "memories")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
