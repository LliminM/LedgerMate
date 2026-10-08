import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getGuidelineRagService } from "../rag";
import type { GuidelineMatch, GuidelineSearchResult } from "../rag/types";
import { TOOL_LABELS } from "../tool-labels";

const Params = Type.Object({
  query: Type.String({
    minLength: 1,
    description:
      "A focused reimbursement-policy question containing the relevant expense facts, for example expense type, traveler, amount, location, and available evidence.",
  }),
  top_k: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 8,
      description: "Maximum number of policy passages to return (default 5).",
    }),
  ),
});

interface GuidelineSearchService {
  search(query: string, topK?: number, signal?: AbortSignal): Promise<GuidelineSearchResult>;
}

export function createSearchReimbursementGuidelineTool(
  getService: () => GuidelineSearchService = getGuidelineRagService,
): ToolDefinition<typeof Params, GuidelineSearchResult> {
  return {
    name: "search_reimbursement_guideline",
    label: TOOL_LABELS.search_reimbursement_guideline,
    description:
      "Search the bundled enterprise reimbursement policy with RAG. Use only when judging policy-dependent eligibility, limits, required evidence, approvals, or exceptions; not for ledger history or general finance.",
    promptSnippet: "Retrieve reimbursement-policy passages with verifiable section and PDF-page citations",
    promptGuidelines: [
      "Call search_reimbursement_guideline only when the answer depends on reimbursement policy; ordinary ledger and finance tasks do not need it.",
      "Include the exact citations returned by this tool for every policy-dependent conclusion. If no passage supports a conclusion, report insufficient policy evidence rather than guessing.",
    ],
    parameters: Params,

    async execute(_id, params, signal) {
      const result = await getService().search(params.query, params.top_k ?? 5, signal);
      const text = formatSearchResult(result);
      return { content: [{ type: "text" as const, text }], details: result };
    },
  };
}

export const searchReimbursementGuidelineTool = createSearchReimbursementGuidelineTool();

export function formatSearchResult(result: GuidelineSearchResult): string {
  if (result.matches.length === 0) {
    return `No reimbursement-policy passages were found for: ${result.query}\nDo not infer a compliance decision from this empty result.`;
  }
  const passages = result.matches.map((match, index) => {
    const citation = formatCitation(match);
    return [`[${index + 1}] ${citation}`, match.text].join("\n");
  });
  return [
    `Policy passages for: ${result.query}`,
    "Use only the text below as policy evidence and preserve its citations in the answer.",
    "",
    ...passages.flatMap((passage, index) => (index === 0 ? [passage] : ["", passage])),
  ].join("\n");
}

export function formatCitation(match: GuidelineMatch): string {
  const section = match.sectionId ? `Section ${match.sectionId} (${match.section})` : match.section;
  const pdfPages = pageRange(match.pageStart, match.pageEnd);
  const printedPages = pageRange(match.printedPageStart, match.printedPageEnd);
  return `${match.title} v${match.version}, ${section}, PDF page ${pdfPages} (printed page ${printedPages})`;
}

function pageRange(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}
