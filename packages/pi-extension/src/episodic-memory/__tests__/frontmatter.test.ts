import { describe, expect, it } from "vitest";
import { parseMemoryMarkdown, serializeMemoryMarkdown } from "../frontmatter";

describe("parseMemoryMarkdown()", () => {
  it("should parse metadata and body from a memory file", () => {
    expect(
      parseMemoryMarkdown(`---
name: zara-coat-in-hangzhou
type: transaction-context
description: The user bought a coat at ZARA in Hangzhou
---

On 2026-10-10, the user bought a coat at ZARA in Hangzhou for CNY 100 using Assets:Cash.
`),
    ).toEqual({
      name: "zara-coat-in-hangzhou",
      type: "transaction-context",
      description: "The user bought a coat at ZARA in Hangzhou",
      body: "On 2026-10-10, the user bought a coat at ZARA in Hangzhou for CNY 100 using Assets:Cash.",
    });
  });

  it("should reject a missing frontmatter block", () => {
    expect(() => parseMemoryMarkdown("just a paragraph")).toThrow("YAML frontmatter");
  });

  it("should reject non-object YAML frontmatter", () => {
    expect(() => parseMemoryMarkdown("---\n- item\n---\nBody\n")).toThrow("frontmatter must be an object");
  });

  it("should reject missing required string metadata", () => {
    expect(() => parseMemoryMarkdown("---\ntype: event\ndescription: Event\n---\nBody\n")).toThrow(
      "requires a non-empty name",
    );
  });

  it("should reject an unsupported type", () => {
    expect(() =>
      parseMemoryMarkdown("---\nname: trip\ntype: preference\ndescription: A trip\n---\nTrip body\n"),
    ).toThrow("type must be one of");
  });

  it("should reject an empty body", () => {
    expect(() => parseMemoryMarkdown("---\nname: trip\ntype: event\ndescription: A trip\n---\n")).toThrow(
      "body must not be empty",
    );
  });
});

describe("serializeMemoryMarkdown()", () => {
  it("should round-trip values that need YAML quoting", () => {
    const memory = {
      name: "coat: hangzhou",
      type: "event" as const,
      description: "Store: ZARA #1",
      body: "The user bought a coat.",
    };

    expect(parseMemoryMarkdown(serializeMemoryMarkdown(memory))).toEqual(memory);
  });
});
