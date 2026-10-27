import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { setBaseDir } from "../config";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-ext-"));

// No mock.module calls — use real modules to avoid mock leaks.
// Extension tests work with real modules + temp filesystem via setBaseDir.
const { createAccountantExtension } = await import("../extension.js");
const { episodicMemoryCoordinator } = await import("../episodic-memory/coordinator.js");
const { findMemoryByName, writeMemory } = await import("../episodic-memory/store.js");

const accountant24Extension = createAccountantExtension;

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
  setBaseDir(BASE);
});

// biome-ignore lint/complexity/noBannedTypes: test helper needs generic callable
type AnyFn = Function;

function createMockPi() {
  const handlers: Record<string, AnyFn> = {};
  return {
    registerTool: vi.fn(() => {}),
    appendEntry: vi.fn(() => {}),
    on: vi.fn((event: string, handler: AnyFn) => {
      handlers[event] = handler;
    }),
    handlers,
  };
}

describe("accountant24Extension()", () => {
  test("should register 10 custom tools (built-ins are pi's own)", () => {
    const pi = createMockPi();
    accountant24Extension(pi as any);
    expect(pi.registerTool).toHaveBeenCalledTimes(10);
  });

  test("should register tool_call, before_agent_start, and agent_settled handlers", () => {
    const pi = createMockPi();
    accountant24Extension(pi as any);
    expect(pi.on).toHaveBeenCalledTimes(3);
    expect(pi.handlers.tool_call).toBeDefined();
    expect(pi.handlers.before_agent_start).toBeDefined();
    expect(pi.handlers.agent_settled).toBeDefined();
  });
});

describe("tool_call handler (memory guard wiring)", () => {
  test("should block a write to memory.md when memory has content", async () => {
    const pi = createMockPi();
    accountant24Extension(pi as any);
    writeFileSync(join(BASE, "memory.md"), "## Defaults\n- currency: EUR\n");

    const result = await pi.handlers.tool_call(
      { type: "tool_call", toolCallId: "t1", toolName: "write", input: { path: "memory.md", content: "rewritten" } },
      { cwd: BASE },
    );
    expect(result).toEqual({ block: true, reason: expect.stringContaining("edit tool") });
  });

  test("should allow an edit to memory.md", async () => {
    const pi = createMockPi();
    accountant24Extension(pi as any);
    writeFileSync(join(BASE, "memory.md"), "## Defaults\n- currency: EUR\n");

    const result = await pi.handlers.tool_call(
      {
        type: "tool_call",
        toolCallId: "t2",
        toolName: "edit",
        input: { path: "memory.md", edits: [{ oldText: "EUR", newText: "USD" }] },
      },
      { cwd: BASE },
    );
    expect(result).toBeUndefined();
  });
});

describe("before_agent_start handler", () => {
  // pi hands the hook its fully assembled base prompt (our system.md via
  // --system-prompt + the <available_skills> block + date/cwd lines); the
  // extension extends that base. Tool snippets + guidelines come from pi's
  // systemPromptOptions (computed from the enabled tools).
  const basePrompt =
    "<soul>\nAccountant24 base from system.md\n</soul>\n" +
    "<available_skills>\n<skill>\n<name>pdf</name>\n</skill>\n</available_skills>\n" +
    "Current date: 2020-01-01\n" +
    "Current working directory: /workspace";

  const beforeEvent = {
    systemPrompt: basePrompt,
    systemPromptOptions: {
      selectedTools: ["read", "bash", "edit", "query", "commit_and_push"],
      toolSnippets: {
        read: "Read file contents",
        bash: "Execute bash commands",
        edit: "Make precise file edits",
        query: "Run hledger reports",
        commit_and_push: "Commit all changes and push to remote",
      },
      promptGuidelines: ["Call commit_and_push after completing a batch of related changes."],
    },
  };

  test("should return object with systemPrompt key", async () => {
    const pi = createMockPi();
    accountant24Extension(pi as any);

    const result = await pi.handlers.before_agent_start(beforeEvent);
    expect(result).toHaveProperty("systemPrompt");
    expect(typeof result.systemPrompt).toBe("string");
    expect(result.systemPrompt.length).toBeGreaterThan(0);
  });

  test("should forward pi's enabled-tool snippets into the tools section", async () => {
    const pi = createMockPi();
    accountant24Extension(pi as any);

    const result = await pi.handlers.before_agent_start(beforeEvent);
    const prompt = result.systemPrompt as string;
    expect(prompt).toContain("<tools>");
    expect(prompt).toContain("</tools>");
    expect(prompt).toContain("- read: Read file contents");
    expect(prompt).toContain("- query: Run hledger reports");
    expect(prompt).toContain("- commit_and_push: Commit all changes and push to remote");
  });

  test("should omit tools without a snippet", async () => {
    const pi = createMockPi();
    accountant24Extension(pi as any);

    const event = {
      systemPrompt: basePrompt,
      systemPromptOptions: {
        selectedTools: ["read", "secret"],
        toolSnippets: { read: "Read file contents" },
        promptGuidelines: [],
      },
    };
    const result = await pi.handlers.before_agent_start(event);
    const prompt = result.systemPrompt as string;
    expect(prompt).toContain("- read:");
    expect(prompt).not.toContain("- secret");
  });

  test("should include context wrapper around dynamic sections", async () => {
    const pi = createMockPi();
    accountant24Extension(pi as any);

    const result = await pi.handlers.before_agent_start(beforeEvent);
    const prompt = result.systemPrompt as string;
    expect(prompt).toContain("<context>");
    expect(prompt).toContain("</context>");

    const contextStart = prompt.indexOf("<context>");
    const datePos = prompt.indexOf("Today's date:");
    expect(datePos).toBeGreaterThan(contextStart);
  });

  test("should include pi's tool guidelines", async () => {
    const pi = createMockPi();
    accountant24Extension(pi as any);

    const result = await pi.handlers.before_agent_start(beforeEvent);
    const prompt = result.systemPrompt as string;
    expect(prompt).toContain("Guidelines:");
    expect(prompt).toContain("commit_and_push after completing a batch");
  });

  test("should preserve pi's assembled base prompt (system.md + skills block) at the start", async () => {
    const pi = createMockPi();
    accountant24Extension(pi as any);

    const result = await pi.handlers.before_agent_start(beforeEvent);
    const prompt = result.systemPrompt as string;
    expect(prompt.startsWith("<soul>\nAccountant24 base from system.md\n</soul>")).toBe(true);
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("Current working directory: /workspace");
  });

  test("should re-stamp pi's baked date line with today's date", async () => {
    const pi = createMockPi();
    accountant24Extension(pi as any);

    const result = await pi.handlers.before_agent_start(beforeEvent);
    const prompt = result.systemPrompt as string;
    const today = new Date().toISOString().split("T")[0];
    expect(prompt).toContain(`Current date: ${today}`);
    expect(prompt).not.toContain("Current date: 2020-01-01");
  });

  test("should append tools and context after the base prompt", async () => {
    const pi = createMockPi();
    accountant24Extension(pi as any);

    const result = await pi.handlers.before_agent_start(beforeEvent);
    const prompt = result.systemPrompt as string;
    const cwdPos = prompt.indexOf("Current working directory:");
    const toolsPos = prompt.indexOf("<tools>");
    const contextPos = prompt.indexOf("<context>");
    expect(cwdPos).toBeLessThan(toolsPos);
    expect(toolsPos).toBeLessThan(contextPos);
  });

  test("should inject only episodic files selected by the side-query", async () => {
    await writeMemory({
      name: "zara-coat",
      type: "transaction-context",
      description: "ZARA coat bought in Hangzhou",
      body: "The user bought a coat at ZARA in Hangzhou.",
    });
    await writeMemory({
      name: "beijing-trip",
      type: "event",
      description: "A trip to Beijing",
      body: "The user visited Beijing.",
    });
    const pi = createMockPi();
    accountant24Extension(pi as any);
    const complete = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '["zara-coat.md"]' }],
      stopReason: "stop",
    });
    const context = {
      model: { id: "test-model" },
      modelRegistry: { complete },
      sessionManager: { getBranch: () => [] },
    };

    const result = await pi.handlers.before_agent_start(
      { ...beforeEvent, prompt: "Where did I buy the coat?" },
      context,
    );
    await episodicMemoryCoordinator.idle();

    expect(result.systemPrompt).toContain('<episodic_memory filename="zara-coat.md">');
    expect(result.systemPrompt).toContain("The user bought a coat at ZARA in Hangzhou.");
    expect(result.systemPrompt).not.toContain("The user visited Beijing.");
  });

  test("should let the turn continue when a queued retry file is malformed", async () => {
    mkdirSync(join(BASE, "memories"), { recursive: true });
    writeFileSync(join(BASE, "memories", ".pending-writes.json"), "invalid json");
    const pi = createMockPi();
    accountant24Extension(pi as any);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const context = {
      model: { id: "test-model" },
      modelRegistry: { complete: vi.fn() },
      sessionManager: { getBranch: () => [] },
    };

    const result = await pi.handlers.before_agent_start({ ...beforeEvent, prompt: "Hello" }, context);
    await episodicMemoryCoordinator.idle();

    expect(result.systemPrompt).toContain("<context>");
    expect(error).toHaveBeenCalledWith("Episodic memory retry failed:", expect.any(Error));
    error.mockRestore();
  });
});

describe("agent_settled handler", () => {
  test("should checkpoint immediately and persist extracted memory in the background queue", async () => {
    const pi = createMockPi();
    accountant24Extension(pi as any);
    const complete = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '[{"name":"zara-coat","type":"transaction-context","description":"ZARA coat bought in Hangzhou","body":"On 2026-10-10 the user bought a coat at ZARA in Hangzhou for CNY 100 using Assets:Cash."}]',
        },
      ],
      stopReason: "stop",
    });
    const branch = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-10-10T00:00:00Z",
        message: { role: "user", content: "I bought a coat in Hangzhou", timestamp: 1 },
      },
    ];

    await pi.handlers.agent_settled(
      { type: "agent_settled" },
      {
        model: { id: "test-model" },
        modelRegistry: { complete },
        sessionManager: { getBranch: () => branch },
      },
    );

    expect(pi.appendEntry).toHaveBeenCalledWith(
      "accountant24-episodic-memory-checkpoint",
      expect.objectContaining({ throughEntryId: "u1", jobId: expect.any(String) }),
    );
    await episodicMemoryCoordinator.idle();
    expect(await findMemoryByName("zara-coat")).toEqual(
      expect.objectContaining({ body: expect.stringContaining("Hangzhou") }),
    );
  });

  test("should do nothing when no model is selected", async () => {
    const pi = createMockPi();
    accountant24Extension(pi as any);
    await pi.handlers.agent_settled(
      { type: "agent_settled" },
      { model: undefined, modelRegistry: {}, sessionManager: { getBranch: () => [] } },
    );
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  test("should contain extraction failures after checkpointing the turn", async () => {
    const pi = createMockPi();
    accountant24Extension(pi as any);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const branch = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-10-10T00:00:00Z",
        message: { role: "user", content: "I visited Hangzhou", timestamp: 1 },
      },
    ];

    await pi.handlers.agent_settled(
      { type: "agent_settled" },
      {
        model: { id: "test-model" },
        modelRegistry: { complete: vi.fn().mockRejectedValue(new Error("provider unavailable")) },
        sessionManager: { getBranch: () => branch },
      },
    );
    await episodicMemoryCoordinator.idle();
    await Promise.resolve();

    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("Episodic memory extraction failed:", expect.any(Error));
    error.mockRestore();
  });
});
