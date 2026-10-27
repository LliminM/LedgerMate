import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { setBaseDir } from "../../config";
import {
  collisionFilenameForMemoryName,
  filenameForMemoryName,
  isSafeMemoryFilename,
  memoryFilePath,
  slugifyMemoryName,
} from "../paths";

afterEach(() => setBaseDir(`${homedir()}/.accountant24`));

describe("slugifyMemoryName()", () => {
  it("should make a lowercase hyphenated slug", () => {
    expect(slugifyMemoryName("ZARA Coat in Hangzhou")).toBe("zara-coat-in-hangzhou");
  });

  it("should preserve Chinese characters", () => {
    expect(slugifyMemoryName("杭州 ZARA 风衣")).toBe("杭州-zara-风衣");
  });

  it("should reserve MEMORY for the catalog on case-insensitive filesystems", () => {
    expect(filenameForMemoryName("memory")).toBe("memory-entry.md");
  });

  it("should use a fallback for punctuation-only names", () => {
    expect(slugifyMemoryName("---")).toBe("episode");
  });
});

describe("memory filenames", () => {
  it("should add a stable collision suffix", () => {
    expect(collisionFilenameForMemoryName("Trip")).toMatch(/^trip-[a-f0-9]{8}\.md$/);
  });

  it("should accept a plain markdown basename", () => {
    expect(isSafeMemoryFilename("hangzhou-trip.md")).toBe(true);
  });

  it.each([
    "../secret.md",
    "nested/secret.md",
    "MEMORY.md",
    ".hidden.md",
    "note.txt",
  ])("should reject unsafe filename %s", (filename) => {
    expect(isSafeMemoryFilename(filename)).toBe(false);
  });

  it("should resolve safe files inside the configured directory", () => {
    setBaseDir("/tmp/a24-memory-path-test");
    expect(memoryFilePath("trip.md")).toBe("/tmp/a24-memory-path-test/memories/trip.md");
  });

  it("should throw instead of resolving traversal", () => {
    expect(() => memoryFilePath("../secret.md")).toThrow("Unsafe episodic memory filename");
  });
});
