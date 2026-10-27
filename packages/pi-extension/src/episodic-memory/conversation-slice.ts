import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DeleteEpisodicMemoryResult } from "./types";

export const MEMORY_CHECKPOINT_TYPE = "accountant24-episodic-memory-checkpoint";
const DEFAULT_MAX_CHARS = 12_000;

export interface MemoryCheckpoint {
  throughEntryId: string;
  jobId: string;
}

export interface ConversationSnapshot {
  entries: SessionEntry[];
  throughEntryId: string;
  conversation: string;
  deletedNames: string[];
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "image") return "[image]";
      if (block.type === "toolCall" && typeof block.name === "string") {
        return `Tool call ${block.name}: ${JSON.stringify(block.arguments ?? {})}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function formatMessage(entry: SessionEntry): string | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.message as unknown as Record<string, unknown>;
  const role = message.role;
  if (role === "user") return `User:\n${textFromContent(message.content)}`;
  if (role === "assistant") return `Assistant:\n${textFromContent(message.content)}`;
  if (role === "toolResult") {
    const status = message.isError === true ? "failed" : "succeeded";
    const toolName = typeof message.toolName === "string" ? message.toolName : "unknown";
    const details = message.details === undefined ? "" : `\nDetails: ${JSON.stringify(message.details)}`;
    return `Tool ${toolName} ${status}:\n${textFromContent(message.content)}${details}`;
  }
  return undefined;
}

export function formatConversationEntries(entries: SessionEntry[], maxChars = DEFAULT_MAX_CHARS): string {
  const formatted = entries
    .map(formatMessage)
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  if (formatted.length <= maxChars) return formatted;
  return `[earlier content omitted]\n${formatted.slice(-maxChars)}`;
}

export function formatRecentConversation(branch: SessionEntry[], currentPrompt: string, maxMessages = 10): string {
  const messageEntries = branch.filter((entry) => entry.type === "message").slice(-maxMessages);
  const conversation = formatConversationEntries(messageEntries, 8_000);
  if (!currentPrompt.trim()) return conversation;
  if (conversation.includes(currentPrompt.trim())) return conversation;
  return `${conversation}${conversation ? "\n\n" : ""}Current user:\n${currentPrompt.trim()}`;
}

export function deletedMemoryNames(entries: SessionEntry[]): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as Record<string, unknown>;
    if (message.role !== "toolResult" || message.toolName !== "delete_episodic_memory" || message.isError === true) {
      continue;
    }
    const details = message.details as Partial<DeleteEpisodicMemoryResult> | undefined;
    if (details?.deleted === true && typeof details.name === "string" && !names.includes(details.name)) {
      names.push(details.name);
    }
  }
  return names;
}

function latestCheckpointIndex(branch: SessionEntry[]): number {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "custom" && entry.customType === MEMORY_CHECKPOINT_TYPE) return index;
  }
  return -1;
}

export function getUnprocessedConversation(branch: SessionEntry[]): ConversationSnapshot | undefined {
  const entries = branch.slice(latestCheckpointIndex(branch) + 1);
  if (!entries.some((entry) => entry.type === "message" && entry.message.role === "user")) return undefined;
  const conversation = formatConversationEntries(entries);
  if (!conversation) return undefined;
  return {
    entries,
    throughEntryId: branch.at(-1)?.id ?? "",
    conversation,
    deletedNames: deletedMemoryNames(entries),
  };
}
