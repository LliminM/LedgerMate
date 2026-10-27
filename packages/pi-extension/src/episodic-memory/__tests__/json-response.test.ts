import { describe, expect, it } from "vitest";
import { parseMemoryCandidates, parseSelectedFilenames, parseUpdatedMemory } from "../json-response";

describe("parseSelectedFilenames()", () => {
  it("should parse a JSON string array", () => {
    expect(parseSelectedFilenames('["coat.md", "trip.md"]')).toEqual(["coat.md", "trip.md"]);
  });

  it("should parse JSON from a fenced response", () => {
    expect(parseSelectedFilenames('```json\n["coat.md"]\n```')).toEqual(["coat.md"]);
  });

  it("should reject prose around JSON", () => {
    expect(() => parseSelectedFilenames('Here: ["coat.md"]')).toThrow("valid JSON");
  });

  it("should reject non-string items", () => {
    expect(() => parseSelectedFilenames('["coat.md", 2]')).toThrow("JSON string array");
  });
});

describe("parseMemoryCandidates()", () => {
  it("should parse an empty candidate array", () => {
    expect(parseMemoryCandidates("[]")).toEqual([]);
  });

  it("should parse a complete candidate", () => {
    expect(
      parseMemoryCandidates(
        '[{"name":"coat","type":"event","description":"Bought a coat","body":"Bought it in Hangzhou."}]',
      ),
    ).toEqual([{ name: "coat", type: "event", description: "Bought a coat", body: "Bought it in Hangzhou." }]);
  });

  it("should reject a non-array extractor response", () => {
    expect(() => parseMemoryCandidates("{}")).toThrow("must return a JSON array");
  });

  it.each([
    '[{"name":"coat","type":"unknown","description":"Bought a coat","body":"Body"}]',
    '[{"name":"","type":"event","description":"Bought a coat","body":"Body"}]',
    '[{"name":"coat","type":"event","description":"Bought a coat"}]',
    '["not-an-object"]',
  ])("should reject invalid candidate %s", (json) => {
    expect(() => parseMemoryCandidates(json)).toThrow("invalid candidate");
  });
});

describe("parseUpdatedMemory()", () => {
  it("should return undefined for null", () => {
    expect(parseUpdatedMemory("null")).toBeUndefined();
  });

  it("should parse a complete replacement", () => {
    expect(
      parseUpdatedMemory('{"name":"trip","type":"ongoing","description":"Current trip","body":"In Hangzhou."}'),
    ).toEqual({ name: "trip", type: "ongoing", description: "Current trip", body: "In Hangzhou." });
  });

  it("should reject an incomplete replacement", () => {
    expect(() => parseUpdatedMemory('{"name":"trip"}')).toThrow("invalid memory");
  });
});
