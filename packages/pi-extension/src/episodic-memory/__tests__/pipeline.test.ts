import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setBaseDir } from "../../config";
import { collisionFilenameForMemoryName } from "../paths";
import { extractAndPersistMemories } from "../pipeline";
import { findMemoryByName, writeMemory } from "../store";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-memory-pipeline-"));

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
  setBaseDir(BASE);
});

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

describe("extractAndPersistMemories()", () => {
  it("should create a new memory returned by extraction", async () => {
    const complete = vi
      .fn()
      .mockResolvedValue(
        '[{"name":"zara-coat","type":"transaction-context","description":"ZARA coat bought in Hangzhou","body":"On 2026-10-10 the user bought a coat at ZARA in Hangzhou for CNY 100 using Assets:Cash."}]',
      );

    await expect(extractAndPersistMemories("completed turn", [], { complete })).resolves.toEqual({
      candidates: 1,
      written: 1,
      unchanged: 0,
      queuedForRetry: 0,
    });
    expect(await findMemoryByName("zara-coat")).toEqual(
      expect.objectContaining({ body: expect.stringContaining("Hangzhou") }),
    );
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("should use a second side-query to rewrite an existing memory", async () => {
    await writeMemory({ name: "trip", type: "event", description: "A trip", body: "The user visited Hangzhou." });
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        '[{"name":"trip","type":"event","description":"A corrected trip","body":"The user says the city was Suzhou."}]',
      )
      .mockResolvedValueOnce(
        '{"name":"trip","type":"event","description":"A trip to Suzhou","body":"The user visited Suzhou, not Hangzhou."}',
      );

    await expect(extractAndPersistMemories("The city was Suzhou, not Hangzhou.", [], { complete })).resolves.toEqual({
      candidates: 1,
      written: 1,
      unchanged: 0,
      queuedForRetry: 0,
    });
    expect((await findMemoryByName("trip"))?.body).toBe("The user visited Suzhou, not Hangzhou.");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("should leave an existing file unchanged when updater returns null", async () => {
    await writeMemory({ name: "trip", type: "event", description: "A trip", body: "The user visited Hangzhou." });
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        '[{"name":"trip","type":"event","description":"A trip","body":"The user visited Hangzhou."}]',
      )
      .mockResolvedValueOnce("null");

    await expect(extractAndPersistMemories("same information", [], { complete })).resolves.toEqual({
      candidates: 1,
      written: 0,
      unchanged: 1,
      queuedForRetry: 0,
    });
  });

  it("should not recreate an exactly named memory deleted in the turn", async () => {
    const complete = vi
      .fn()
      .mockResolvedValue('[{"name":"trip","type":"event","description":"A trip","body":"The user visited Hangzhou."}]');

    await expect(extractAndPersistMemories("forget the trip", ["trip"], { complete })).resolves.toEqual({
      candidates: 0,
      written: 0,
      unchanged: 0,
      queuedForRetry: 0,
    });
    expect(await findMemoryByName("trip")).toBeUndefined();
  });

  it("should deduplicate candidates with the same stable name", async () => {
    const complete = vi
      .fn()
      .mockResolvedValue(
        '[{"name":"trip","type":"event","description":"Old","body":"Old body"},{"name":"trip","type":"event","description":"New","body":"New body"}]',
      );
    await extractAndPersistMemories("turn", [], { complete });
    expect(await findMemoryByName("trip")).toEqual(expect.objectContaining({ description: "New", body: "New body" }));
  });

  it("should skip an existing memory when its rewrite response is invalid", async () => {
    await writeMemory({ name: "trip", type: "event", description: "A trip", body: "The user visited Hangzhou." });
    const complete = vi
      .fn()
      .mockResolvedValueOnce('[{"name":"trip","type":"event","description":"Correction","body":"The city changed."}]')
      .mockResolvedValueOnce(
        '{"name":"different-name","type":"event","description":"Correction","body":"The city changed."}',
      );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(extractAndPersistMemories("correction", [], { complete })).resolves.toEqual({
      candidates: 1,
      written: 0,
      unchanged: 0,
      queuedForRetry: 0,
    });
    expect(error).toHaveBeenCalledWith("Episodic memory update failed for trip:", expect.any(Error));
    error.mockRestore();
  });

  it("should queue a fully extracted memory when its file cannot be replaced", async () => {
    mkdirSync(join(BASE, "memories", "blocked.md"), { recursive: true });
    mkdirSync(join(BASE, "memories", collisionFilenameForMemoryName("blocked")), { recursive: true });
    const complete = vi
      .fn()
      .mockResolvedValue('[{"name":"blocked","type":"event","description":"Blocked event","body":"Useful context."}]');

    await expect(extractAndPersistMemories("turn", [], { complete })).resolves.toEqual({
      candidates: 1,
      written: 0,
      unchanged: 0,
      queuedForRetry: 1,
    });
  });

  it("should log when both memory writing and retry recording fail", async () => {
    mkdirSync(join(BASE, "memories", "blocked.md"), { recursive: true });
    mkdirSync(join(BASE, "memories", collisionFilenameForMemoryName("blocked")), { recursive: true });
    writeFileSync(join(BASE, "memories", ".pending-writes.json"), "invalid json");
    const complete = vi
      .fn()
      .mockResolvedValue('[{"name":"blocked","type":"event","description":"Blocked event","body":"Useful context."}]');
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await extractAndPersistMemories("turn", [], { complete });

    expect(error).toHaveBeenCalledWith(
      "Episodic memory write and retry recording failed for blocked:",
      expect.objectContaining({ writeError: expect.any(Error), pendingError: expect.any(Error) }),
    );
    error.mockRestore();
  });
});
