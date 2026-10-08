import { describe, expect, it, vi } from "vitest";
import type { GuidelineSearchResult } from "../../rag/types";
import {
  createSearchReimbursementGuidelineTool,
  formatCitation,
  formatSearchResult,
} from "../search-reimbursement-guideline";

const searchResult: GuidelineSearchResult = {
  query: "hotel invoice",
  indexRebuilt: true,
  matches: [
    {
      chunkId: "chunk-1",
      text: "住宿费报销应提供发票。",
      distance: 0.1,
      title: "Employee Reimbursement Guideline",
      version: "2026.1",
      section: "差旅费",
      sectionId: "3",
      pageStart: 10,
      pageEnd: 10,
      printedPageStart: 3,
      printedPageEnd: 3,
    },
  ],
};

type TextToolResult = { content: Array<{ type: string; text: string }>; details: GuidelineSearchResult };
type RunTool = (id: string, params: { query: string; top_k?: number }, signal?: AbortSignal) => Promise<TextToolResult>;

describe("searchReimbursementGuidelineTool.execute()", () => {
  it("should lazily resolve the service, use default top_k=5, and forward the abort signal", async () => {
    const search = vi.fn(async () => searchResult);
    const getService = vi.fn(() => ({ search }));
    const tool = createSearchReimbursementGuidelineTool(getService);
    const run = tool.execute as unknown as RunTool;
    const controller = new AbortController();
    const result = await run("call-1", { query: "hotel invoice" }, controller.signal);

    expect(getService).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith("hotel invoice", 5, controller.signal);
    expect(result.details).toBe(searchResult);
    expect(result.content[0].text).toContain("Section 3 (差旅费), PDF page 10 (printed page 3)");
    expect(result.content[0].text).toContain("住宿费报销应提供发票。");
  });

  it("should pass an explicit result limit", async () => {
    const search = vi.fn(async () => searchResult);
    const tool = createSearchReimbursementGuidelineTool(() => ({ search }));
    const run = tool.execute as unknown as RunTool;
    await run("call-2", { query: "taxi", top_k: 3 });
    expect(search).toHaveBeenCalledWith("taxi", 3, undefined);
  });

  it("should propagate indexing or search failures", async () => {
    const tool = createSearchReimbursementGuidelineTool(() => ({
      search: vi.fn(async () => {
        throw new Error("DASHSCOPE_API_KEY is not set");
      }),
    }));
    const run = tool.execute as unknown as RunTool;
    await expect(run("call-3", { query: "meal" })).rejects.toThrow("DASHSCOPE_API_KEY is not set");
  });
});

describe("formatSearchResult()", () => {
  it("should warn the agent not to infer a decision from an empty retrieval", () => {
    expect(formatSearchResult({ query: "unknown", indexRebuilt: false, matches: [] })).toBe(
      "No reimbursement-policy passages were found for: unknown\nDo not infer a compliance decision from this empty result.",
    );
  });

  it("should number multiple passages and require citation preservation", () => {
    const text = formatSearchResult({ ...searchResult, matches: [searchResult.matches[0], searchResult.matches[0]] });
    expect(text).toContain("preserve its citations");
    expect(text).toContain("[1] Employee Reimbursement Guideline");
    expect(text).toContain("[2] Employee Reimbursement Guideline");
  });
});

describe("formatCitation()", () => {
  it("should format page ranges and a heading without a numbered section", () => {
    expect(
      formatCitation({
        ...searchResult.matches[0],
        sectionId: null,
        section: "General Rules",
        pageStart: 12,
        pageEnd: 13,
        printedPageStart: 5,
        printedPageEnd: 6,
      }),
    ).toBe("Employee Reimbursement Guideline v2026.1, General Rules, PDF page 12-13 (printed page 5-6)");
  });
});
