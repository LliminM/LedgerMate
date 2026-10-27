import type { EpisodicMemoryCandidate, EpisodicMemorySummary } from "./types";

export const SELECT_MEMORIES_SYSTEM_PROMPT = `You select episodic memory files for a finance assistant.
Return only a JSON array of exact filenames from the catalog, with no prose or Markdown.
Select a file only when its content could help answer or act on the recent conversation.
Return at most the requested number. Return [] when no memory is relevant.`;

export function buildSelectMemoriesPrompt(
  recentConversation: string,
  catalog: EpisodicMemorySummary[],
  maxItems: number,
): string {
  const catalogText = catalog
    .map((memory) => `${memory.filename} | ${memory.name} | ${memory.type} | ${memory.description}`)
    .join("\n");
  return `Maximum files: ${maxItems}

<recent_conversation>
${recentConversation}
</recent_conversation>

<memory_catalog>
${catalogText}
</memory_catalog>`;
}

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `You extract episodic memories from one completed assistant turn.
Return only a JSON array of objects with exactly these fields: {"name","type","description","body"}.
Allowed type values: "event", "ongoing", "transaction-context".

Save only concrete user-specific past events, situations, or in-progress contexts that may matter in a future conversation.
Do not save durable preferences, standing rules, recurring arrangements, or stable profile facts; those belong in long-term memory.
Do not save company policy or document knowledge, facts derivable from the ledger alone, assistant suggestions, speculation, or unresolved guesses.
Treat user statements and successful tool results as evidence. Failed tool calls do not establish facts.
For transaction-context memories, include enough natural-language hledger clues to find the transaction later when available: absolute date, payee, amount and currency, account, and description. Do not invent missing clues.
Use one short stable kebab-case name per situation. Reuse an existing catalog name exactly when the new turn adds to or corrects that situation.
Only return genuinely new or corrected information. Return [] when nothing qualifies.
Never recreate information the user explicitly deleted in this turn.`;

export function buildExtractMemoriesPrompt(
  conversation: string,
  catalog: EpisodicMemorySummary[],
  deletedNames: string[],
): string {
  const catalogText = catalog.length
    ? catalog.map((memory) => `${memory.name} | ${memory.type} | ${memory.description}`).join("\n")
    : "(empty)";
  const deletedText = deletedNames.length ? deletedNames.join("\n") : "(none)";
  return `<existing_memory_catalog>
${catalogText}
</existing_memory_catalog>

<deleted_in_this_turn>
${deletedText}
</deleted_in_this_turn>

<completed_turn>
${conversation}
</completed_turn>`;
}

export const UPDATE_MEMORY_SYSTEM_PROMPT = `You update one existing episodic memory from new evidence.
Return only one complete JSON object with exactly {"name","type","description","body"}, or null when the existing memory already covers the evidence.
Keep the supplied name exactly unchanged. Preserve useful unrelated details from the existing memory.
Apply the user's latest explicit correction over older content and remove facts it makes obsolete.
Use only evidence in the completed turn and the existing memory. Never invent details.
Keep the description concise. Keep the body as one compact natural-language paragraph rather than an event log.`;

export function buildUpdateMemoryPrompt(
  existingMarkdown: string,
  candidate: EpisodicMemoryCandidate,
  conversation: string,
): string {
  return `<existing_memory>
${existingMarkdown}
</existing_memory>

<new_candidate>
${JSON.stringify(candidate)}
</new_candidate>

<completed_turn>
${conversation}
</completed_turn>`;
}
