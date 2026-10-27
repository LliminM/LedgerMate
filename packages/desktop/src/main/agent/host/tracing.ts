// Local, append-only tracing for agent runs. The collector consumes the same
// raw AgentSession event stream as the renderer, but records only lifecycle
// metadata and aggregate sizes: prompts, reasoning, tool arguments, and tool
// results are deliberately never copied into trace files.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";

export const TRACE_SCHEMA_VERSION = 1;

type TraceValue = string | number | boolean | null;
type TraceFields = Record<string, TraceValue>;
type TraceStatus = "ok" | "error" | "cancelled" | "incomplete";
type SpanKind = "agent" | "llm" | "tool" | "retry" | "compaction";

export interface TraceSessionContext {
  sessionPath: string;
  sessionId?: string;
  model?: { provider?: string; id?: string };
  thinkingLevel?: string;
}

export type TraceRecord =
  | {
      schemaVersion: typeof TRACE_SCHEMA_VERSION;
      recordType: "trace_start";
      timestamp: string;
      traceId: string;
      rootSpanId: string;
      sessionId?: string;
      sessionFile: string;
      attributes: TraceFields;
    }
  | {
      schemaVersion: typeof TRACE_SCHEMA_VERSION;
      recordType: "span_start";
      timestamp: string;
      traceId: string;
      spanId: string;
      parentSpanId: string;
      name: string;
      kind: SpanKind;
      attributes: TraceFields;
    }
  | {
      schemaVersion: typeof TRACE_SCHEMA_VERSION;
      recordType: "span_end";
      timestamp: string;
      traceId: string;
      spanId: string;
      name: string;
      kind: SpanKind;
      durationMs: number;
      status: TraceStatus;
      attributes: TraceFields;
      metrics: TraceFields;
    }
  | {
      schemaVersion: typeof TRACE_SCHEMA_VERSION;
      recordType: "trace_end";
      timestamp: string;
      traceId: string;
      rootSpanId: string;
      durationMs: number;
      status: TraceStatus;
      summary: {
        success: boolean;
        attempts: number;
        llmTurns: number;
        toolCalls: number;
        toolErrors: number;
        maxConcurrentTools: number;
        retries: number;
        compactions: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        totalTokens: number;
        cost: number;
        finalStopReason?: string;
      };
    };

export interface TraceSink {
  append(fileName: string, record: TraceRecord): void;
  flush(): Promise<void>;
}

/** Non-blocking JSONL writer. Writes are serialized so lines from concurrent
 * sessions never interleave, while the agent event callback remains sync. */
export class JsonlTraceSink implements TraceSink {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly tracesDir: string,
    private readonly onError: (error: Error) => void = (error) => console.error(`[agent-trace] ${error.message}`),
  ) {}

  append(fileName: string, record: TraceRecord): void {
    const path = join(this.tracesDir, basename(fileName));
    const line = `${JSON.stringify(record)}\n`;
    this.pending = this.pending
      .then(async () => {
        await mkdir(this.tracesDir, { recursive: true });
        await appendFile(path, line, "utf8");
      })
      .catch((error: unknown) => {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      });
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}

interface TraceClock {
  wallTimeMs(): number;
  monotonicMs(): number;
}

interface Mark {
  wallMs: number;
  monotonicMs: number;
}

interface ActiveSpan {
  id: string;
  name: string;
  kind: SpanKind;
  start: Mark;
  attributes: TraceFields;
}

interface ActiveTrace {
  id: string;
  rootSpanId: string;
  fileName: string;
  start: Mark;
  context: TraceSessionContext;
  attempts: number;
  llmTurns: number;
  toolCalls: number;
  toolErrors: number;
  maxConcurrentTools: number;
  retries: number;
  compactions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  lastStopReason?: string;
  currentTurnIndex: number;
  activeAttempt?: ActiveSpan;
  activeLlm?: ActiveSpan & { firstToken?: Mark };
  activeTools: Map<string, ActiveSpan & { updates: number }>;
  activeRetry?: ActiveSpan;
  activeCompaction?: ActiveSpan;
}

export interface AgentTraceObserver {
  observe(context: TraceSessionContext, event: Record<string, unknown>): void;
  closeSession(sessionPath: string, status: Extract<TraceStatus, "cancelled" | "incomplete">): void;
  flush(): Promise<void>;
}

interface AgentTraceCollectorOptions {
  sink: TraceSink;
  clock?: TraceClock;
  idFactory?: () => string;
  onError?: (error: Error) => void;
}

const defaultClock: TraceClock = {
  wallTimeMs: () => Date.now(),
  monotonicMs: () => performance.now(),
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const finiteNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const stringValue = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const serializedBytes = (value: unknown): number | null => {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
  } catch {
    return null;
  }
};

const statusForStopReason = (stopReason: string | undefined): TraceStatus => {
  if (stopReason === "aborted") return "cancelled";
  if (stopReason === "error" || stopReason === "length") return "error";
  if (stopReason === "stop" || stopReason === "toolUse" || stopReason === "deferred") return "ok";
  return "incomplete";
};

/** Builds one trace per fully-settled agent run. A run stays open across
 * automatic retry/compaction cycles and is closed only by agent_settled. */
export class AgentTraceCollector implements AgentTraceObserver {
  private readonly sink: TraceSink;
  private readonly clock: TraceClock;
  private readonly idFactory: () => string;
  private readonly onError: (error: Error) => void;
  private readonly active = new Map<string, ActiveTrace>();

  constructor(options: AgentTraceCollectorOptions) {
    this.sink = options.sink;
    this.clock = options.clock ?? defaultClock;
    this.idFactory = options.idFactory ?? randomUUID;
    this.onError = options.onError ?? ((error) => console.error(`[agent-trace] ${error.message}`));
  }

  observe(context: TraceSessionContext, event: Record<string, unknown>): void {
    try {
      this.handleEvent(context, event);
    } catch (error: unknown) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  closeSession(sessionPath: string, status: Extract<TraceStatus, "cancelled" | "incomplete">): void {
    try {
      const trace = this.active.get(sessionPath);
      if (trace) this.endTrace(trace, this.mark(), status);
    } catch (error: unknown) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async flush(): Promise<void> {
    try {
      await this.sink.flush();
    } catch (error: unknown) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleEvent(context: TraceSessionContext, event: Record<string, unknown>): void {
    const type = stringValue(event.type);
    if (!type) return;
    const mark = this.mark();

    if (type === "agent_start") {
      const trace = this.active.get(context.sessionPath) ?? this.startTrace(context, mark);
      trace.context = context;
      this.startAttempt(trace, mark);
      return;
    }

    const trace = this.active.get(context.sessionPath);
    if (!trace) return;
    trace.context = context;

    switch (type) {
      case "agent_end":
        this.endAttempt(trace, mark, event.willRetry === true);
        return;
      case "agent_settled":
        this.endTrace(trace, mark, statusForStopReason(trace.lastStopReason));
        return;
      case "turn_start":
        this.startLlm(trace, mark);
        return;
      case "message_update":
        this.observeMessageUpdate(trace, event, mark);
        return;
      case "message_end":
        this.observeMessageEnd(trace, event, mark);
        return;
      case "turn_end":
        if (trace.activeLlm) this.endLlm(trace, mark, "incomplete", {});
        return;
      case "tool_execution_start":
        this.startTool(trace, event, mark);
        return;
      case "tool_execution_update":
        this.updateTool(trace, event);
        return;
      case "tool_execution_end":
        this.endTool(trace, event, mark);
        return;
      case "auto_retry_start":
        this.startRetry(trace, event, mark);
        return;
      case "auto_retry_end":
        this.endRetry(trace, event, mark);
        return;
      case "compaction_start":
        this.startCompaction(trace, event, mark);
        return;
      case "compaction_end":
        this.endCompaction(trace, event, mark);
        return;
      default:
        return;
    }
  }

  private mark(): Mark {
    return { wallMs: this.clock.wallTimeMs(), monotonicMs: this.clock.monotonicMs() };
  }

  private startTrace(context: TraceSessionContext, mark: Mark): ActiveTrace {
    const id = this.idFactory();
    const rootSpanId = this.idFactory();
    const stamp = new Date(mark.wallMs).toISOString().replace(/[:.]/g, "-");
    const trace: ActiveTrace = {
      id,
      rootSpanId,
      fileName: `${stamp}_${id}.jsonl`,
      start: mark,
      context,
      attempts: 0,
      llmTurns: 0,
      toolCalls: 0,
      toolErrors: 0,
      maxConcurrentTools: 0,
      retries: 0,
      compactions: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      cost: 0,
      currentTurnIndex: -1,
      activeTools: new Map(),
    };
    this.active.set(context.sessionPath, trace);
    this.write(trace, {
      schemaVersion: TRACE_SCHEMA_VERSION,
      recordType: "trace_start",
      timestamp: this.iso(mark),
      traceId: id,
      rootSpanId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      sessionFile: basename(context.sessionPath),
      attributes: {
        ...(context.model?.provider ? { "model.provider": context.model.provider } : {}),
        ...(context.model?.id ? { "model.id": context.model.id } : {}),
        ...(context.thinkingLevel ? { "agent.thinking_level": context.thinkingLevel } : {}),
        "content.capture": false,
      },
    });
    return trace;
  }

  private startAttempt(trace: ActiveTrace, mark: Mark): void {
    if (trace.activeAttempt) this.endSpan(trace, trace.activeAttempt, mark, "incomplete", {}, {});
    trace.attempts += 1;
    trace.activeAttempt = this.startSpan(trace, "agent.attempt", "agent", mark, {
      "agent.attempt": trace.attempts,
    });
  }

  private endAttempt(trace: ActiveTrace, mark: Mark, willRetry: boolean): void {
    const attempt = trace.activeAttempt;
    if (!attempt) return;
    this.endSpan(trace, attempt, mark, statusForStopReason(trace.lastStopReason), { willRetry }, {});
    trace.activeAttempt = undefined;
  }

  private startLlm(trace: ActiveTrace, mark: Mark): void {
    if (trace.activeLlm) this.endLlm(trace, mark, "incomplete", {});
    trace.currentTurnIndex += 1;
    trace.llmTurns += 1;
    trace.activeLlm = this.startSpan(trace, "llm.turn", "llm", mark, {
      "agent.turn_index": trace.currentTurnIndex,
    });
  }

  private observeMessageUpdate(trace: ActiveTrace, event: Record<string, unknown>, mark: Mark): void {
    const llm = trace.activeLlm;
    if (!llm || llm.firstToken) return;
    const assistantEvent = asRecord(event.assistantMessageEvent);
    const deltaType = stringValue(assistantEvent?.type);
    const delta = assistantEvent?.delta;
    if (deltaType?.endsWith("_delta") && typeof delta === "string" && delta.length > 0) llm.firstToken = mark;
  }

  private observeMessageEnd(trace: ActiveTrace, event: Record<string, unknown>, mark: Mark): void {
    const message = asRecord(event.message);
    if (message?.role !== "assistant") return;
    const stopReason = stringValue(message.stopReason);
    trace.lastStopReason = stopReason;
    if (!trace.activeLlm) return;

    const usage = asRecord(message.usage);
    const cost = asRecord(usage?.cost);
    const metrics: TraceFields = {
      inputTokens: finiteNumber(usage?.input),
      outputTokens: finiteNumber(usage?.output),
      cacheReadTokens: finiteNumber(usage?.cacheRead),
      cacheWriteTokens: finiteNumber(usage?.cacheWrite),
      totalTokens: finiteNumber(usage?.totalTokens),
      cost: finiteNumber(cost?.total),
    };
    trace.inputTokens += metrics.inputTokens as number;
    trace.outputTokens += metrics.outputTokens as number;
    trace.cacheReadTokens += metrics.cacheReadTokens as number;
    trace.cacheWriteTokens += metrics.cacheWriteTokens as number;
    trace.totalTokens += metrics.totalTokens as number;
    trace.cost += metrics.cost as number;

    const attributes: TraceFields = {
      ...(stringValue(message.provider) ? { "model.provider": String(message.provider) } : {}),
      ...(stringValue(message.model) ? { "model.id": String(message.model) } : {}),
      ...(stringValue(message.responseModel) ? { "model.response_model": String(message.responseModel) } : {}),
      ...(stopReason ? { "llm.stop_reason": stopReason } : {}),
      "llm.has_error_message": typeof message.errorMessage === "string" && message.errorMessage.length > 0,
    };
    this.endLlm(trace, mark, statusForStopReason(stopReason), attributes, metrics);
  }

  private endLlm(
    trace: ActiveTrace,
    mark: Mark,
    status: TraceStatus,
    attributes: TraceFields,
    metrics: TraceFields = {},
  ): void {
    const llm = trace.activeLlm;
    if (!llm) return;
    const ttftMs = llm.firstToken ? this.duration(llm.start, llm.firstToken) : null;
    const durationMs = this.duration(llm.start, mark);
    const outputTokens = finiteNumber(metrics.outputTokens);
    const generationMs = ttftMs === null ? 0 : Math.max(0, durationMs - ttftMs);
    this.endSpan(trace, llm, mark, status, attributes, {
      ...metrics,
      timeToFirstTokenMs: ttftMs,
      outputTokensPerSecond: outputTokens > 0 && generationMs > 0 ? outputTokens / (generationMs / 1000) : null,
    });
    trace.activeLlm = undefined;
  }

  private startTool(trace: ActiveTrace, event: Record<string, unknown>, mark: Mark): void {
    const toolCallId = stringValue(event.toolCallId);
    if (!toolCallId) return;
    const existing = trace.activeTools.get(toolCallId);
    if (existing) this.endSpan(trace, existing, mark, "incomplete", { "tool.duplicate_start": true }, {});
    trace.toolCalls += 1;
    const span = this.startSpan(trace, `tool.${stringValue(event.toolName) ?? "unknown"}`, "tool", mark, {
      "agent.turn_index": trace.currentTurnIndex,
      "tool.call_id": toolCallId,
      "tool.name": stringValue(event.toolName) ?? "unknown",
      "tool.arguments_bytes": serializedBytes(event.args),
    });
    trace.activeTools.set(toolCallId, { ...span, updates: 0 });
    trace.maxConcurrentTools = Math.max(trace.maxConcurrentTools, trace.activeTools.size);
  }

  private updateTool(trace: ActiveTrace, event: Record<string, unknown>): void {
    const toolCallId = stringValue(event.toolCallId);
    const tool = toolCallId ? trace.activeTools.get(toolCallId) : undefined;
    if (tool) tool.updates += 1;
  }

  private endTool(trace: ActiveTrace, event: Record<string, unknown>, mark: Mark): void {
    const toolCallId = stringValue(event.toolCallId);
    if (!toolCallId) return;
    const tool = trace.activeTools.get(toolCallId);
    if (!tool) return;
    const isError = event.isError === true;
    if (isError) trace.toolErrors += 1;
    this.endSpan(
      trace,
      tool,
      mark,
      isError ? "error" : "ok",
      {
        "tool.is_error": isError,
        "tool.result_bytes": serializedBytes(event.result),
      },
      { updates: tool.updates },
    );
    trace.activeTools.delete(toolCallId);
  }

  private startRetry(trace: ActiveTrace, event: Record<string, unknown>, mark: Mark): void {
    if (trace.activeRetry) this.endSpan(trace, trace.activeRetry, mark, "incomplete", {}, {});
    trace.retries += 1;
    trace.activeRetry = this.startSpan(trace, "agent.retry", "retry", mark, {
      "retry.attempt": finiteNumber(event.attempt),
      "retry.delay_ms": finiteNumber(event.delayMs),
      "retry.has_error_message": typeof event.errorMessage === "string" && event.errorMessage.length > 0,
    });
  }

  private endRetry(trace: ActiveTrace, event: Record<string, unknown>, mark: Mark): void {
    const retry = trace.activeRetry;
    if (!retry) return;
    const success = event.success === true;
    this.endSpan(trace, retry, mark, success ? "ok" : "error", { "retry.success": success }, {});
    trace.activeRetry = undefined;
  }

  private startCompaction(trace: ActiveTrace, event: Record<string, unknown>, mark: Mark): void {
    if (trace.activeCompaction) this.endSpan(trace, trace.activeCompaction, mark, "incomplete", {}, {});
    trace.compactions += 1;
    trace.activeCompaction = this.startSpan(trace, "agent.compaction", "compaction", mark, {
      "compaction.reason": stringValue(event.reason) ?? "unknown",
    });
  }

  private endCompaction(trace: ActiveTrace, event: Record<string, unknown>, mark: Mark): void {
    const compaction = trace.activeCompaction;
    if (!compaction) return;
    const result = asRecord(event.result);
    const aborted = event.aborted === true;
    const hasError = typeof event.errorMessage === "string" && event.errorMessage.length > 0;
    this.endSpan(
      trace,
      compaction,
      mark,
      aborted ? "cancelled" : hasError ? "error" : "ok",
      {
        "compaction.aborted": aborted,
        "compaction.will_retry": event.willRetry === true,
        "compaction.has_error_message": hasError,
        "compaction.summary_bytes": serializedBytes(result?.summary),
      },
      { tokensBefore: finiteNumber(result?.tokensBefore) },
    );
    trace.activeCompaction = undefined;
  }

  private startSpan(trace: ActiveTrace, name: string, kind: SpanKind, mark: Mark, attributes: TraceFields): ActiveSpan {
    const span: ActiveSpan = { id: this.idFactory(), name, kind, start: mark, attributes };
    this.write(trace, {
      schemaVersion: TRACE_SCHEMA_VERSION,
      recordType: "span_start",
      timestamp: this.iso(mark),
      traceId: trace.id,
      spanId: span.id,
      parentSpanId: trace.rootSpanId,
      name,
      kind,
      attributes,
    });
    return span;
  }

  private endSpan(
    trace: ActiveTrace,
    span: ActiveSpan,
    mark: Mark,
    status: TraceStatus,
    attributes: TraceFields,
    metrics: TraceFields,
  ): void {
    this.write(trace, {
      schemaVersion: TRACE_SCHEMA_VERSION,
      recordType: "span_end",
      timestamp: this.iso(mark),
      traceId: trace.id,
      spanId: span.id,
      name: span.name,
      kind: span.kind,
      durationMs: this.duration(span.start, mark),
      status,
      attributes: { ...span.attributes, ...attributes },
      metrics,
    });
  }

  private endTrace(trace: ActiveTrace, mark: Mark, status: TraceStatus): void {
    if (trace.activeLlm) this.endLlm(trace, mark, status === "cancelled" ? "cancelled" : "incomplete", {});
    for (const tool of trace.activeTools.values()) {
      this.endSpan(
        trace,
        tool,
        mark,
        status === "cancelled" ? "cancelled" : "incomplete",
        {},
        {
          updates: tool.updates,
        },
      );
    }
    trace.activeTools.clear();
    if (trace.activeRetry) {
      this.endSpan(trace, trace.activeRetry, mark, status === "cancelled" ? "cancelled" : "incomplete", {}, {});
      trace.activeRetry = undefined;
    }
    if (trace.activeCompaction) {
      this.endSpan(trace, trace.activeCompaction, mark, status === "cancelled" ? "cancelled" : "incomplete", {}, {});
      trace.activeCompaction = undefined;
    }
    if (trace.activeAttempt) {
      this.endSpan(trace, trace.activeAttempt, mark, status, {}, {});
      trace.activeAttempt = undefined;
    }

    this.write(trace, {
      schemaVersion: TRACE_SCHEMA_VERSION,
      recordType: "trace_end",
      timestamp: this.iso(mark),
      traceId: trace.id,
      rootSpanId: trace.rootSpanId,
      durationMs: this.duration(trace.start, mark),
      status,
      summary: {
        success: status === "ok",
        attempts: trace.attempts,
        llmTurns: trace.llmTurns,
        toolCalls: trace.toolCalls,
        toolErrors: trace.toolErrors,
        maxConcurrentTools: trace.maxConcurrentTools,
        retries: trace.retries,
        compactions: trace.compactions,
        inputTokens: trace.inputTokens,
        outputTokens: trace.outputTokens,
        cacheReadTokens: trace.cacheReadTokens,
        cacheWriteTokens: trace.cacheWriteTokens,
        totalTokens: trace.totalTokens,
        cost: trace.cost,
        ...(trace.lastStopReason ? { finalStopReason: trace.lastStopReason } : {}),
      },
    });
    this.active.delete(trace.context.sessionPath);
  }

  private write(trace: ActiveTrace, record: TraceRecord): void {
    this.sink.append(trace.fileName, record);
  }

  private iso(mark: Mark): string {
    return new Date(mark.wallMs).toISOString();
  }

  private duration(start: Mark, end: Mark): number {
    return Math.max(0, end.monotonicMs - start.monotonicMs);
  }
}
