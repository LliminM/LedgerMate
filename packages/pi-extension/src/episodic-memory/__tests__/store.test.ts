import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setBaseDir } from "../../config";
import {
  deleteMemoryByName,
  findMemoryByName,
  listMemories,
  readMemoryFile,
  rebuildMemoryIndex,
  writeMemory,
} from "../store";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-episodic-store-"));

const coat = {
  name: "zara-coat-in-hangzhou",
  type: "transaction-context" as const,
  description: "The user bought a ZARA coat in Hangzhou",
  body: "On 2026-10-10, the user bought a coat at ZARA in Hangzhou for CNY 100 using Assets:Cash.",
};

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
  setBaseDir(BASE);
});

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

describe("writeMemory()", () => {
  it("should create a markdown file and rebuild the catalog", async () => {
    const saved = await writeMemory(coat);

    expect(saved.filename).toBe("zara-coat-in-hangzhou.md");
    expect(await readMemoryFile(saved.filename)).toEqual(saved);
    expect(readFileSync(join(BASE, "memories", "MEMORY.md"), "utf8")).toBe(
      "# Episodic memories\n\n- [zara-coat-in-hangzhou](zara-coat-in-hangzhou.md) — The user bought a ZARA coat in Hangzhou\n",
    );
  });

  it("should overwrite the selected file when updating an existing memory", async () => {
    await writeMemory(coat);
    const updated = { ...coat, body: `${coat.body} The coat was black.` };

    await writeMemory(updated, "zara-coat-in-hangzhou.md");

    expect((await readMemoryFile("zara-coat-in-hangzhou.md")).body).toContain("black");
    expect(await listMemories()).toHaveLength(1);
  });

  it("should avoid overwriting a different memory with the same slug", async () => {
    await writeMemory({ ...coat, name: "Trip!" });
    const second = await writeMemory({ ...coat, name: "Trip?" });

    expect(second.filename).toMatch(/^trip-[a-f0-9]{8}\.md$/);
    expect(await listMemories()).toHaveLength(2);
  });

  it("should exclude malformed markdown files from the catalog", async () => {
    mkdirSync(join(BASE, "memories"), { recursive: true });
    writeFileSync(join(BASE, "memories", "broken.md"), "not frontmatter");
    await writeMemory(coat);

    expect(await listMemories()).toEqual([expect.objectContaining({ name: coat.name })]);
    expect(readFileSync(join(BASE, "memories", "MEMORY.md"), "utf8")).not.toContain("broken.md");
  });

  it("should clean up its temporary file when atomic replacement fails", async () => {
    mkdirSync(join(BASE, "memories", "blocked.md"), { recursive: true });

    await expect(
      writeMemory({ name: "blocked", type: "event", description: "Blocked", body: "Body" }, "blocked.md"),
    ).rejects.toThrow();

    expect(readdirSync(join(BASE, "memories")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("findMemoryByName()", () => {
  it("should match the exact stored name", async () => {
    await writeMemory(coat);
    expect(await findMemoryByName(coat.name)).toEqual(expect.objectContaining(coat));
    expect(await findMemoryByName("ZARA-COAT-IN-HANGZHOU")).toBeUndefined();
  });
});

describe("deleteMemoryByName()", () => {
  it("should delete the exact memory and rebuild the catalog", async () => {
    await writeMemory(coat);

    expect(await deleteMemoryByName(coat.name)).toBe(true);

    expect(await listMemories()).toEqual([]);
    expect(readFileSync(join(BASE, "memories", "MEMORY.md"), "utf8")).toBe("# Episodic memories\n");
  });

  it("should return false without changing files when no exact memory exists", async () => {
    await writeMemory(coat);
    expect(await deleteMemoryByName("missing")).toBe(false);
    expect(await listMemories()).toHaveLength(1);
  });
});

describe("rebuildMemoryIndex()", () => {
  it("should create an empty catalog when the directory is missing", async () => {
    await rebuildMemoryIndex();
    expect(readFileSync(join(BASE, "memories", "MEMORY.md"), "utf8")).toBe("# Episodic memories\n");
  });

  it("should surface non-missing directory read errors", async () => {
    const fileWorkspace = join(BASE, "workspace-file");
    writeFileSync(fileWorkspace, "not a directory");
    setBaseDir(fileWorkspace);
    await expect(listMemories()).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(existsSync(fileWorkspace)).toBe(true);
  });
});
