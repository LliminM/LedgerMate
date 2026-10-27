import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  deletedMemoryNames,
  formatConversationEntries,
  formatRecentConversation,
  getUnprocessedConversation,
  MEMORY_CHECKPOINT_TYPE,
} from "../conversation-slice";

function entry(id: string, message: Record<string, unknown>): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: "2026-10-10T00:00:00Z", message } as never;
}

const user = entry("u1", { role: "user", content: "I bought a coat in Hangzhou", timestamp: 1 });
const assistant = entry("a1", {
  role: "assistant",
  content: [
    { type: "text", text: "I will record it." },
    { type: "toolCall", id: "t1", name: "add_transactions", arguments: { payee: "ZARA" } },
  ],
  timestamp: 2,
});
const tool = entry("t1", {
  role: "toolResult",
  toolName: "add_transactions",
  content: [{ type: "text", text: "Transaction saved" }],
  details: { date: "2026-10-10" },
  isError: false,
  timestamp: 3,
});

describe("formatConversationEntries()", () => {
  it("should format user, assistant tool calls, and successful tool details", () => {
    const formatted = formatConversationEntries([user, assistant, tool]);
    expect(formatted).toContain("User:\nI bought a coat in Hangzhou");
    expect(formatted).toContain('Tool call add_transactions: {"payee":"ZARA"}');
    expect(formatted).toContain("Tool add_transactions succeeded:");
    expect(formatted).toContain('Details: {"date":"2026-10-10"}');
  });

  it("should retain the newest content when the character budget is exceeded", () => {
    expect(formatConversationEntries([entry("u", { role: "user", content: "1234567890" })], 5)).toBe(
      "[earlier content omitted]\n67890",
    );
  });

  it("should ignore unknown content blocks and message roles", () => {
    const unknownRole = entry("x", { role: "custom", content: [{ type: "unknown" }, null] });
    expect(formatConversationEntries([unknownRole])).toBe("");
  });
});

describe("formatRecentConversation()", () => {
  it("should append a current prompt not yet present in the branch", () => {
    expect(formatRecentConversation([user], "Where was it?", 10)).toContain("Current user:\nWhere was it?");
  });

  it("should not duplicate the current prompt already present in the branch", () => {
    const formatted = formatRecentConversation([user], "I bought a coat in Hangzhou", 10);
    expect(formatted.match(/I bought a coat in Hangzhou/g)).toHaveLength(1);
  });
});

describe("getUnprocessedConversation()", () => {
  it("should return only entries after the latest checkpoint", () => {
    const checkpoint = {
      type: "custom",
      customType: MEMORY_CHECKPOINT_TYPE,
      data: { throughEntryId: "u1", jobId: "old" },
      id: "c1",
      parentId: "u1",
      timestamp: "2026-10-10T00:00:01Z",
    } as SessionEntry;
    const nextUser = entry("u2", { role: "user", content: "The coat was black", timestamp: 4 });

    const snapshot = getUnprocessedConversation([user, checkpoint, nextUser]);

    expect(snapshot?.entries).toEqual([nextUser]);
    expect(snapshot?.throughEntryId).toBe("u2");
    expect(snapshot?.conversation).not.toContain("Hangzhou");
    expect(snapshot?.conversation).toContain("black");
  });

  it("should return undefined when there is no new user message", () => {
    expect(getUnprocessedConversation([assistant, tool])).toBeUndefined();
  });
});

describe("deletedMemoryNames()", () => {
  it("should return exact names from successful delete tool results", () => {
    const deleted = entry("d1", {
      role: "toolResult",
      toolName: "delete_episodic_memory",
      content: [{ type: "text", text: "Deleted" }],
      details: { name: "coat", deleted: true },
      isError: false,
    });
    expect(deletedMemoryNames([deleted])).toEqual(["coat"]);
  });

  it("should ignore failed or no-op deletes", () => {
    const failed = entry("d1", {
      role: "toolResult",
      toolName: "delete_episodic_memory",
      details: { name: "coat", deleted: true },
      isError: true,
    });
    const missing = entry("d2", {
      role: "toolResult",
      toolName: "delete_episodic_memory",
      details: { name: "trip", deleted: false },
      isError: false,
    });
    expect(deletedMemoryNames([failed, missing])).toEqual([]);
  });
});
