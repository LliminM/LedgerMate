import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentTraceCollector,
  JsonlTraceSink,
  TRACE_SCHEMA_VERSION,
  type TraceRecord,
  type TraceSessionContext,
  type TraceSink,
} from "../tracing";

class MemorySink implements TraceSink {
  readonly writes: Array<{ fileName: string; record: TraceRecord }> = [];

  append(fileName: string, record: TraceRecord): void {
    this.writes.push({ fileName, record });
  }

  async flush(): Promise<void> {}
}

class FakeClock {
  wall = Date.UTC(2026, 0, 2, 3, 4, 5);
  monotonic = 0;

  wallTimeMs = () => this.wall;
  monotonicMs = () => this.monotonic;

  advance(ms: number): void {
    this.wall += ms;
    this.monotonic += ms;
  }
}

const context: TraceSessionContext = {
  sessionPath: "/workspace/sessions/chat.jsonl",
  sessionId: "session-1",
  model: { provider: "anthropic", id: "claude-sonnet" },
  thinkingLevel: "medium",
};

function makeCollector() {
  const sink = new MemorySink();
  const clock = new FakeClock();
  let id = 0;
  const collector = new AgentTraceCollector({
    sink,
    clock,
    idFactory: () => `id-${++id}`,
  });
  const emit = (event: Record<string, unknown>, advanceMs = 0) => {
    clock.advance(advanceMs);
    collector.observe(context, event);
  };
  return { sink, clock, collector, emit };
}

const recordsOf = <T extends TraceRecord["recordType"]>(sink: MemorySink, recordType: T) =>
  sink.writes
    .map((w) => w.record)
    .filter((r): r is Extract<TraceRecord, { recordType: T }> => r.recordType === recordType);

const spanEnds = (sink: MemorySink, kind: Extract<TraceRecord, { recordType: "span_end" }>["kind"]) =>
  recordsOf(sink, "span_end").filter((r) => r.kind === kind);

describe("AgentTraceCollector", () => {
  it("should record one completed run with exact LLM latency, usage, cost, and throughput", () => {
    const { sink, emit } = makeCollector();

    emit({ type: "agent_start" });
    emit({ type: "turn_start" }, 100);
    emit(
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" },
      },
      250,
    );
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer" } }, 100);
    emit(
      {
        type: "message_end",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet",
          responseModel: "claude-sonnet-2026",
          stopReason: "stop",
          usage: {
            input: 100,
            output: 30,
            cacheRead: 40,
            cacheWrite: 5,
            totalTokens: 175,
            cost: { total: 0.0125 },
          },
        },
      },
      650,
    );
    emit({ type: "agent_end", willRetry: false }, 100);
    emit({ type: "agent_settled" }, 900);

    const starts = recordsOf(sink, "trace_start");
    expect(starts).toEqual([
      {
        schemaVersion: TRACE_SCHEMA_VERSION,
        recordType: "trace_start",
        timestamp: "2026-01-02T03:04:05.000Z",
        traceId: "id-1",
        rootSpanId: "id-2",
        sessionId: "session-1",
        sessionFile: "chat.jsonl",
        attributes: {
          "model.provider": "anthropic",
          "model.id": "claude-sonnet",
          "agent.thinking_level": "medium",
          "content.capture": false,
        },
      },
    ]);

    expect(spanEnds(sink, "llm")).toEqual([
      expect.objectContaining({
        name: "llm.turn",
        durationMs: 1000,
        status: "ok",
        attributes: expect.objectContaining({
          "agent.turn_index": 0,
          "model.provider": "anthropic",
          "model.id": "claude-sonnet",
          "model.response_model": "claude-sonnet-2026",
          "llm.stop_reason": "stop",
          "llm.has_error_message": false,
        }),
        metrics: {
          inputTokens: 100,
          outputTokens: 30,
          cacheReadTokens: 40,
          cacheWriteTokens: 5,
          totalTokens: 175,
          cost: 0.0125,
          timeToFirstTokenMs: 250,
          outputTokensPerSecond: 40,
        },
      }),
    ]);

    expect(recordsOf(sink, "trace_end")).toEqual([
      expect.objectContaining({
        durationMs: 2100,
        status: "ok",
        summary: {
          success: true,
          attempts: 1,
          llmTurns: 1,
          toolCalls: 0,
          toolErrors: 0,
          maxConcurrentTools: 0,
          retries: 0,
          compactions: 0,
          inputTokens: 100,
          outputTokens: 30,
          cacheReadTokens: 40,
          cacheWriteTokens: 5,
          totalTokens: 175,
          cost: 0.0125,
          finalStopReason: "stop",
        },
      }),
    ]);
    expect(JSON.stringify(sink.writes)).not.toContain("private reasoning");
    expect(JSON.stringify(sink.writes)).not.toContain("answer");
    expect(new Set(sink.writes.map((w) => w.fileName))).toEqual(new Set(["2026-01-02T03-04-05-000Z_id-1.jsonl"]));
  });

  it("should record parallel tool durations, errors, update counts, and byte sizes without content", () => {
    const { sink, emit } = makeCollector();
    emit({ type: "agent_start" });
    emit({ type: "turn_start" }, 10);
    emit(
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "toolUse", usage: { output: 1 } },
      },
      10,
    );
    emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "secret.txt" } }, 10);
    emit({ type: "tool_execution_start", toolCallId: "b", toolName: "query", args: { sql: "private sql" } }, 20);
    emit({ type: "tool_execution_update", toolCallId: "a", partialResult: { text: "private partial" } }, 30);
    emit({ type: "tool_execution_end", toolCallId: "b", result: { content: "private result" }, isError: false }, 40);
    emit({ type: "tool_execution_end", toolCallId: "a", result: { content: "private failure" }, isError: true }, 50);
    emit({ type: "agent_end" }, 10);
    emit({ type: "agent_settled" }, 10);

    const tools = spanEnds(sink, "tool");
    expect(tools).toHaveLength(2);
    expect(tools.find((r) => r.attributes["tool.call_id"] === "a")).toMatchObject({
      durationMs: 140,
      status: "error",
      attributes: {
        "agent.turn_index": 0,
        "tool.call_id": "a",
        "tool.name": "read",
        "tool.arguments_bytes": Buffer.byteLength(JSON.stringify({ path: "secret.txt" })),
        "tool.is_error": true,
        "tool.result_bytes": Buffer.byteLength(JSON.stringify({ content: "private failure" })),
      },
      metrics: { updates: 1 },
    });
    expect(tools.find((r) => r.attributes["tool.call_id"] === "b")).toMatchObject({
      durationMs: 70,
      status: "ok",
      metrics: { updates: 0 },
    });
    expect(recordsOf(sink, "trace_end")[0]?.summary).toMatchObject({
      toolCalls: 2,
      toolErrors: 1,
      maxConcurrentTools: 2,
    });
    const serialized = JSON.stringify(sink.writes);
    for (const secret of ["secret.txt", "private sql", "private partial", "private result", "private failure"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("should keep one trace across retry attempts and compaction", () => {
    const { sink, emit } = makeCollector();
    emit({ type: "agent_start" });
    emit({ type: "turn_start" }, 10);
    emit(
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "private provider error" },
      },
      10,
    );
    emit({ type: "agent_end", willRetry: true }, 10);
    emit({ type: "auto_retry_start", attempt: 1, delayMs: 500, errorMessage: "private retry error" }, 10);
    emit({ type: "auto_retry_end", success: true }, 500);
    emit({ type: "compaction_start", reason: "overflow" }, 10);
    emit(
      {
        type: "compaction_end",
        reason: "overflow",
        result: { summary: "private compacted context", tokensBefore: 1234 },
        aborted: false,
        willRetry: true,
      },
      50,
    );
    emit({ type: "agent_start" }, 10);
    emit({ type: "turn_start" }, 10);
    emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }, 100);
    emit({ type: "agent_end", willRetry: false }, 10);
    emit({ type: "agent_settled" }, 10);

    expect(recordsOf(sink, "trace_start")).toHaveLength(1);
    expect(spanEnds(sink, "agent").map((r) => r.status)).toEqual(["error", "ok"]);
    expect(spanEnds(sink, "retry")).toEqual([
      expect.objectContaining({
        durationMs: 500,
        status: "ok",
        attributes: expect.objectContaining({
          "retry.attempt": 1,
          "retry.delay_ms": 500,
          "retry.has_error_message": true,
          "retry.success": true,
        }),
      }),
    ]);
    expect(spanEnds(sink, "compaction")).toEqual([
      expect.objectContaining({
        durationMs: 50,
        status: "ok",
        attributes: expect.objectContaining({
          "compaction.reason": "overflow",
          "compaction.aborted": false,
          "compaction.will_retry": true,
          "compaction.has_error_message": false,
          "compaction.summary_bytes": Buffer.byteLength(JSON.stringify("private compacted context")),
        }),
        metrics: { tokensBefore: 1234 },
      }),
    ]);
    expect(recordsOf(sink, "trace_end")[0]).toMatchObject({
      status: "ok",
      summary: { attempts: 2, retries: 1, compactions: 1, success: true },
    });
    expect(JSON.stringify(sink.writes)).not.toContain("private provider error");
    expect(JSON.stringify(sink.writes)).not.toContain("private retry error");
    expect(JSON.stringify(sink.writes)).not.toContain("private compacted context");
  });

  it("should close every active span as cancelled when its session is disposed", () => {
    const { sink, collector, emit, clock } = makeCollector();
    emit({ type: "agent_start" });
    emit({ type: "turn_start" }, 10);
    emit({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} }, 10);
    emit({ type: "auto_retry_start", attempt: 1, delayMs: 50 }, 10);
    emit({ type: "compaction_start", reason: "manual" }, 10);
    clock.advance(60);

    collector.closeSession(context.sessionPath, "cancelled");
    collector.closeSession(context.sessionPath, "cancelled");

    expect(recordsOf(sink, "trace_end")).toEqual([expect.objectContaining({ status: "cancelled", durationMs: 100 })]);
    expect(spanEnds(sink, "llm")[0]).toMatchObject({ status: "cancelled", durationMs: 90 });
    expect(spanEnds(sink, "tool")[0]).toMatchObject({ status: "cancelled", durationMs: 80 });
    expect(spanEnds(sink, "retry")[0]).toMatchObject({ status: "cancelled", durationMs: 70 });
    expect(spanEnds(sink, "compaction")[0]).toMatchObject({ status: "cancelled", durationMs: 60 });
    expect(spanEnds(sink, "agent")[0]).toMatchObject({ status: "cancelled", durationMs: 100 });
  });

  it("should ignore unrelated events before a run and repeated non-delta updates", () => {
    const { sink, emit } = makeCollector();
    emit({ type: "tool_execution_start", toolCallId: "orphan", toolName: "read" });
    emit({ type: "agent_start" });
    emit({ type: "turn_start" });
    emit({ type: "message_update", assistantMessageEvent: { type: "start" } }, 10);
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } }, 10);
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "first" } }, 10);
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "second" } }, 10);
    emit({ type: "message_end", message: { role: "toolResult" } }, 10);
    emit({ type: "turn_end" }, 10);
    emit({ type: "agent_settled" }, 10);

    expect(spanEnds(sink, "tool")).toEqual([]);
    expect(spanEnds(sink, "llm")[0]).toMatchObject({
      status: "incomplete",
      durationMs: 60,
      metrics: { timeToFirstTokenMs: 30, outputTokensPerSecond: null },
    });
    expect(recordsOf(sink, "trace_end")[0]).toMatchObject({ status: "incomplete" });
  });

  it("should isolate simultaneous sessions into separate files and traces", () => {
    const { sink, collector, clock } = makeCollector();
    const other = { ...context, sessionPath: "/workspace/sessions/other.jsonl", sessionId: "session-2" };
    collector.observe(context, { type: "agent_start" });
    clock.advance(10);
    collector.observe(other, { type: "agent_start" });
    clock.advance(10);
    collector.observe(context, { type: "agent_settled" });
    clock.advance(10);
    collector.observe(other, { type: "agent_settled" });

    expect(recordsOf(sink, "trace_start").map((r) => r.sessionFile)).toEqual(["chat.jsonl", "other.jsonl"]);
    expect(new Set(sink.writes.map((w) => w.fileName)).size).toBe(2);
    expect(recordsOf(sink, "trace_end")).toHaveLength(2);
  });

  it("should tolerate malformed, duplicated, and out-of-order lifecycle events", () => {
    const sink = new MemorySink();
    const clock = new FakeClock();
    let id = 0;
    const collector = new AgentTraceCollector({ sink, clock, idFactory: () => `edge-${++id}` });
    const minimal = { sessionPath: "/workspace/sessions/minimal.jsonl" };
    const emit = (event: Record<string, unknown>) => {
      clock.advance(10);
      collector.observe(minimal, event);
    };
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    emit({});
    emit({ type: "agent_start" });
    emit({ type: "unknown_event" });
    emit({ type: "agent_start" });
    emit({ type: "agent_end" });
    emit({ type: "agent_end" });
    emit({ type: "turn_start" });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "first" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ignored" } });
    emit({ type: "turn_start" });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "length",
        errorMessage: "not persisted",
        usage: { input: "invalid", output: 0, cost: null },
      },
    });
    emit({ type: "message_end", message: { role: "assistant", stopReason: "deferred" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "orphan" } });
    emit({ type: "tool_execution_start" });
    emit({ type: "tool_execution_start", toolCallId: "tool", args: undefined });
    emit({ type: "tool_execution_start", toolCallId: "tool" });
    emit({ type: "tool_execution_update" });
    emit({ type: "tool_execution_update", toolCallId: "missing" });
    emit({ type: "tool_execution_update", toolCallId: "tool" });
    emit({ type: "tool_execution_end" });
    emit({ type: "tool_execution_end", toolCallId: "missing" });
    emit({ type: "tool_execution_end", toolCallId: "tool", result: circular });
    emit({ type: "auto_retry_end", success: true });
    emit({ type: "auto_retry_start" });
    emit({ type: "auto_retry_start", attempt: Number.NaN, errorMessage: "" });
    emit({ type: "auto_retry_end", success: false });
    emit({ type: "compaction_end" });
    emit({ type: "compaction_start" });
    emit({ type: "compaction_start", reason: "manual" });
    emit({ type: "compaction_end", aborted: true });
    emit({ type: "compaction_start", reason: "threshold" });
    emit({ type: "compaction_end", errorMessage: "not persisted", result: null });
    emit({ type: "agent_settled" });
    collector.closeSession(minimal.sessionPath, "incomplete");

    expect(recordsOf(sink, "trace_start")[0]).toMatchObject({
      sessionFile: "minimal.jsonl",
      attributes: { "content.capture": false },
    });
    expect(spanEnds(sink, "agent").map((span) => span.status)).toEqual(["incomplete", "incomplete"]);
    expect(spanEnds(sink, "llm").map((span) => span.status)).toEqual(["incomplete", "error"]);
    expect(spanEnds(sink, "tool").map((span) => span.status)).toEqual(["incomplete", "ok"]);
    expect(spanEnds(sink, "tool").at(-1)?.attributes).toMatchObject({
      "tool.name": "unknown",
      "tool.arguments_bytes": 0,
      "tool.result_bytes": null,
    });
    expect(spanEnds(sink, "retry").map((span) => span.status)).toEqual(["incomplete", "error"]);
    expect(spanEnds(sink, "compaction").map((span) => span.status)).toEqual(["incomplete", "cancelled", "error"]);
    expect(recordsOf(sink, "trace_end")[0]).toMatchObject({
      status: "ok",
      summary: { success: true, attempts: 2, retries: 2, compactions: 3, finalStopReason: "deferred" },
    });
    expect(JSON.stringify(sink.writes)).not.toContain("not persisted");
  });

  it("should report non-Error failures from observe, close, and flush through the configured handler", async () => {
    let fail = false;
    const sink: TraceSink = {
      append: () => {
        if (fail) throw "plain append failure";
      },
      flush: async () => {
        throw "plain flush failure";
      },
    };
    const onError = vi.fn();
    const collector = new AgentTraceCollector({ sink, onError });
    collector.observe(context, { type: "agent_start" });
    fail = true;

    collector.closeSession(context.sessionPath, "cancelled");
    await collector.flush();

    expect(onError).toHaveBeenNthCalledWith(1, new Error("plain append failure"));
    expect(onError).toHaveBeenNthCalledWith(2, new Error("plain flush failure"));
  });

  it("should use the default error reporter when observe fails", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const collector = new AgentTraceCollector({
      sink: {
        append: () => {
          throw "sink failed";
        },
        flush: async () => {},
      },
    });

    collector.observe(context, { type: "agent_start" });

    expect(consoleError).toHaveBeenCalledWith("[agent-trace] sink failed");
  });

  it("should contain collector and sink failures instead of throwing into the agent stream", async () => {
    const sinkError = new Error("sink failed");
    const sink: TraceSink = {
      append: () => {
        throw sinkError;
      },
      flush: async () => {
        throw sinkError;
      },
    };
    const onError = vi.fn();
    const collector = new AgentTraceCollector({ sink, onError });

    expect(() => collector.observe(context, { type: "agent_start" })).not.toThrow();
    await expect(collector.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenNthCalledWith(1, sinkError);
    expect(onError).toHaveBeenNthCalledWith(2, sinkError);
  });
});

describe("JsonlTraceSink", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("should create the traces directory lazily and append parseable JSON lines", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "a24-tracing-"));
    dirs.push(workspace);
    const traces = path.join(workspace, "traces");
    const sink = new JsonlTraceSink(traces);
    const collector = new AgentTraceCollector({ sink, idFactory: () => "fixed-id" });

    expect(existsSync(traces)).toBe(false);
    collector.observe(context, { type: "agent_start" });
    collector.observe(context, { type: "agent_settled" });
    await collector.flush();

    expect(readdirSync(traces)).toHaveLength(1);
    const file = path.join(traces, readdirSync(traces)[0] ?? "");
    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as TraceRecord[];
    expect(lines.map((line) => line.recordType)).toEqual(["trace_start", "span_start", "span_end", "trace_end"]);
    expect(lines.every((line) => line.schemaVersion === TRACE_SCHEMA_VERSION)).toBe(true);
  });

  it("should report a filesystem failure and keep flush safe", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "a24-tracing-error-"));
    dirs.push(workspace);
    const occupied = path.join(workspace, "traces");
    writeFileSync(occupied, "not a directory");
    const onError = vi.fn();
    const sink = new JsonlTraceSink(occupied, onError);
    const record: TraceRecord = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      recordType: "trace_start",
      timestamp: "2026-01-01T00:00:00.000Z",
      traceId: "trace",
      rootSpanId: "root",
      sessionFile: "session.jsonl",
      attributes: {},
    };

    sink.append("../escape.jsonl", record);
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(workspace, "escape.jsonl"))).toBe(false);
  });
});
