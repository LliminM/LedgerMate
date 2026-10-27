import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deleteMemoryByName, episodicMemoryCoordinator } from "../episodic-memory";
import type { DeleteEpisodicMemoryResult } from "../episodic-memory/types";
import { TOOL_LABELS } from "../tool-labels";

const Params = Type.Object({
  name: Type.String({
    minLength: 1,
    description: "Exact episodic-memory name from the injected memory context",
  }),
});

type DeleteMemory = (name: string) => Promise<boolean>;

export function createDeleteEpisodicMemoryTool(
  deleteMemory: DeleteMemory = (name) => episodicMemoryCoordinator.enqueue(() => deleteMemoryByName(name)),
): ToolDefinition<typeof Params, DeleteEpisodicMemoryResult> {
  return {
    name: "delete_episodic_memory",
    label: TOOL_LABELS.delete_episodic_memory,
    description:
      "Delete one episodic memory only when the user explicitly asks to forget or delete that remembered situation. The name must exactly match an injected episodic memory.",
    promptSnippet: "Delete an episodic memory after an explicit user request to forget it",
    promptGuidelines: [
      "Call delete_episodic_memory only when the user explicitly asks to forget or delete a remembered event or situation.",
    ],
    executionMode: "sequential",
    parameters: Params,

    async execute(_id, params) {
      const deleted = await deleteMemory(params.name);
      const details = { name: params.name, deleted };
      return {
        content: [
          {
            type: "text",
            text: deleted
              ? `Deleted episodic memory: ${params.name}`
              : `No episodic memory exists with the exact name: ${params.name}`,
          },
        ],
        details,
      };
    },
  };
}

export const deleteEpisodicMemoryTool = createDeleteEpisodicMemoryTool();
