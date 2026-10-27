import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createMemorySideQuery,
  episodicMemoryCoordinator,
  extractAndPersistMemories,
  formatRecentConversation,
  getUnprocessedConversation,
  loadRelevantMemories,
  MEMORY_CHECKPOINT_TYPE,
  retryPendingWrites,
} from "./episodic-memory";
import { serializeMemoryMarkdown } from "./episodic-memory/frontmatter";
import { listAccounts, listPayees, listTags } from "./ledger";
import { getMemory, guardMemoryToolCall } from "./memory";
import { buildContextSection, buildToolsSection, patchBakedDate } from "./system-prompt";
import {
  addBalanceAssertionsTool,
  addPricesTool,
  addTransactionsTool,
  bulkEditTransactionsTool,
  commitAndPushTool,
  deleteEpisodicMemoryTool,
  extractTextTool,
  queryTool,
  searchReimbursementGuidelineTool,
  validateTool,
} from "./tools";

// The desktop app renders all UI from the RPC event stream, so this extension
// registers only domain behavior — tools and the system prompt. No pi TUI
// customization (headers, footer, editor, autocomplete, etc.), and no workspace
// setup: the app seeds the workspace at launch (main/workspace.ts).
export function createAccountantExtension(pi: ExtensionAPI): void {
  // Register custom tools (pi registers its own built-in tools, bound to the agent
  // cwd, which the app sets to the workspace).
  pi.registerTool(queryTool);
  pi.registerTool(addBalanceAssertionsTool);
  pi.registerTool(addPricesTool);
  pi.registerTool(addTransactionsTool);
  pi.registerTool(bulkEditTransactionsTool);
  pi.registerTool(commitAndPushTool);
  pi.registerTool(deleteEpisodicMemoryTool);
  pi.registerTool(extractTextTool);
  pi.registerTool(searchReimbursementGuidelineTool);
  pi.registerTool(validateTool);

  // memory.md has no dedicated tool — the agent maintains it with pi's built-in
  // edit tool. This hook blocks the two escape hatches the system prompt cannot
  // enforce: wholesale `write` rewrites and bash access to the file.
  pi.on("tool_call", (event, ctx) => guardMemoryToolCall(event, ctx.cwd));

  // Extend pi's assembled base prompt before each agent turn. The base
  // (event.systemPrompt) already carries our system.md (loaded via
  // --system-prompt), pi's native <available_skills> block, and date/cwd lines —
  // so only the app-specific sections are appended here. The tool snippets +
  // guidelines come from pi's own systemPromptOptions, which reflects the
  // *enabled* tools (built-in + custom) — so toggling tools via pi flags is
  // honored here without hardcoding any tool list. pi bakes the date at session
  // setup and a desktop session can span days, so re-stamp it each turn.
  pi.on("before_agent_start", async (event, ctx) => {
    const today = new Date().toISOString().split("T")[0];
    const sideQuery = ctx && createMemorySideQuery(ctx);
    const branch = ctx?.sessionManager.getBranch() ?? [];
    const recentConversation = formatRecentConversation(branch, event.prompt ?? "");

    // Retry already-extracted writes in the same FIFO as extraction, but never
    // delay this turn: cross-chat memory is eventually consistent by design.
    if (ctx) {
      void episodicMemoryCoordinator
        .enqueue(() => retryPendingWrites())
        .catch((error) => console.error("Episodic memory retry failed:", error));
    }

    const [memory, accounts, payees, tags, episodicMemories] = await Promise.all([
      getMemory(),
      listAccounts(),
      listPayees(),
      listTags(),
      sideQuery ? loadRelevantMemories(recentConversation, sideQuery, 3) : Promise.resolve([]),
    ]);

    const { selectedTools = [], toolSnippets = {}, promptGuidelines = [] } = event.systemPromptOptions;
    const tools = selectedTools
      .filter((name) => toolSnippets[name])
      .map((name) => ({ name, snippet: toolSnippets[name] }));

    return {
      systemPrompt:
        patchBakedDate(event.systemPrompt, today) +
        buildToolsSection(tools, promptGuidelines) +
        buildContextSection({
          today,
          memory,
          accounts,
          payees,
          tags,
          episodicMemories: episodicMemories.map((episode) => ({
            filename: episode.filename,
            content: serializeMemoryMarkdown(episode),
          })),
        }),
    };
  });

  // Extraction is deliberately detached from the response path. A checkpoint
  // is persisted immediately so the same settled turn is not extracted twice;
  // the actual LLM call and atomic write continue in the workspace FIFO.
  pi.on("agent_settled", (_event, ctx) => {
    const sideQuery = createMemorySideQuery(ctx);
    if (!sideQuery) return;

    const snapshot = getUnprocessedConversation(ctx.sessionManager.getBranch());
    if (!snapshot) return;

    pi.appendEntry(MEMORY_CHECKPOINT_TYPE, {
      throughEntryId: snapshot.throughEntryId,
      jobId: randomUUID(),
    });

    void episodicMemoryCoordinator
      .enqueue(async () => {
        await retryPendingWrites();
        await extractAndPersistMemories(snapshot.conversation, snapshot.deletedNames, sideQuery);
      })
      .catch((error) => console.error("Episodic memory extraction failed:", error));
  });
}
