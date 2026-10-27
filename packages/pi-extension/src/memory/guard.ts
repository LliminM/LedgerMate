import { isAbsolute, relative, resolve } from "node:path";
import { isToolCallEventType, type ToolCallEvent, type ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { getMemory } from "./memory";
import { isMemoryFilePath } from "./paths";

function isEpisodicMemoryPath(path: string, cwd: string): boolean {
  const directory = resolve(cwd, "memories");
  const target = resolve(isAbsolute(path) ? path : resolve(cwd, path));
  const fromDirectory = relative(directory, target);
  return fromDirectory === "" || (!fromDirectory.startsWith("..") && !isAbsolute(fromDirectory));
}

// memory.md is maintained with pi's built-in `edit` tool (granular,
// diff-visible updates). This guard enforces the two rules the system prompt
// alone cannot guarantee: no wholesale rewrites via `write` once memory has
// content, and no bash access to the file.
export async function guardMemoryToolCall(event: ToolCallEvent, cwd: string): Promise<ToolCallEventResult | undefined> {
  if (
    (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) &&
    isEpisodicMemoryPath(event.input.path, cwd)
  ) {
    return {
      block: true,
      reason:
        "Episodic memories are managed by the background memory process. " +
        "Do not edit files under memories/ directly; use delete_episodic_memory only for an explicit forget request.",
    };
  }

  if (isToolCallEventType("write", event) && isMemoryFilePath(event.input.path, cwd)) {
    const memory = await getMemory();
    // The first save into an empty memory file is a creation, not a rewrite.
    if (memory !== "") {
      return {
        block: true,
        reason:
          "memory.md already has content. Do not rewrite it wholesale. " +
          "Use the edit tool with targeted oldText/newText replacements that change only the affected lines. " +
          "The current memory is in the <memory> block of the system prompt.",
      };
    }
  }

  if (
    isToolCallEventType("bash", event) &&
    typeof event.input.command === "string" &&
    (event.input.command.includes("memory.md") ||
      event.input.command.includes(resolve(cwd, "memories")) ||
      /(?:^|[^A-Za-z0-9_-])memories(?:[/\\]|(?=[^A-Za-z0-9_-]|$))/.test(event.input.command))
  ) {
    return {
      block: true,
      reason:
        "Do not access memory files with bash. " +
        "Long-term memory is in the <memory> block and uses targeted edit tool calls; " +
        "episodic memory is managed automatically.",
    };
  }

  return undefined;
}
