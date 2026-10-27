import { describe, expect, it } from "vitest";
import type { GuidelineMatch } from "../../types";
import { type ExpectedEvidence, evaluateRetrieval, evidenceMatches } from "../metrics";

const match = (overrides: Partial<GuidelineMatch> = {}): GuidelineMatch => ({
  chunkId: "chunk",
  text: "policy text",
  distance: 0.1,
  title: "Expense Policy",
  version: "1",
  section: "差旅费",
  sectionId: "29",
  pageStart: 32,
  pageEnd: 32,
  printedPageStart: 25,
  printedPageEnd: 25,
  ...overrides,
});

const evidence = (overrides: Partial<ExpectedEvidence> = {}): ExpectedEvidence => ({
  section: "29",
  page: 32,
  printedPage: 25,
  ...overrides,
});

describe("evidenceMatches()", () => {
  it("should require both the numeric section and PDF page to match", () => {
    expect(evidenceMatches(evidence(), match())).toBe(true);
    expect(evidenceMatches(evidence({ section: "28" }), match())).toBe(false);
    expect(evidenceMatches(evidence({ page: 31 }), match())).toBe(false);
  });

  it("should match a named table section using the leaf of its gold path", () => {
    expect(
      evidenceMatches(
        evidence({ section: "第三部分/国内差旅住宿费限额标准表", page: 79 }),
        match({ sectionId: null, section: "国内差旅住宿费限额标准表", pageStart: 79, pageEnd: 79 }),
      ),
    ).toBe(true);
  });

  it("should normalize full-width and whitespace differences in named sections", () => {
    expect(
      evidenceMatches(
        evidence({ section: "第三部分／住宿费 标准表", page: 79 }),
        match({ sectionId: null, section: "住宿费标准表", pageStart: 79, pageEnd: 79 }),
      ),
    ).toBe(true);
  });

  it("should match a gold page inside an actual page range", () => {
    expect(evidenceMatches(evidence({ page: 32 }), match({ pageStart: 31, pageEnd: 33 }))).toBe(true);
  });
});

describe("evaluateRetrieval()", () => {
  it("should calculate Hit@K, macro Recall@K, and MRR@K from ranked evidence", () => {
    const result = evaluateRetrieval(
      [
        {
          id: "partial",
          question: "question one",
          expectedEvidence: [evidence(), evidence({ section: "table", page: 79 })],
          matches: [
            match({ sectionId: "4", pageStart: 10, pageEnd: 10 }),
            match(),
            match({ sectionId: "5", pageStart: 11, pageEnd: 11 }),
          ],
        },
        {
          id: "miss",
          question: "question two",
          expectedEvidence: [evidence({ section: "8", page: 13 })],
          matches: [match({ sectionId: "9", pageStart: 14, pageEnd: 14 })],
        },
      ],
      5,
    );

    expect(result).toMatchObject({ caseCount: 2, k: 5, hitCount: 1, hitAtK: 0.5 });
    expect(result.recallAtK).toBe(0.25);
    expect(result.meanReciprocalRankAtK).toBe(0.25);
    expect(result.results[0]).toMatchObject({
      hit: true,
      recall: 0.5,
      firstRelevantRank: 2,
      reciprocalRank: 0.5,
    });
    expect(result.results[1]).toMatchObject({
      hit: false,
      recall: 0,
      firstRelevantRank: null,
      reciprocalRank: 0,
    });
  });

  it("should count duplicate retrieved chunks for the same evidence only once", () => {
    const expected = evidence();
    const result = evaluateRetrieval(
      [{ id: "duplicate", question: "q", expectedEvidence: [expected], matches: [match(), match()] }],
      5,
    );
    expect(result.recallAtK).toBe(1);
    expect(result.results[0].matchedEvidence).toEqual([expected]);
  });

  it("should ignore relevant results ranked after K", () => {
    const result = evaluateRetrieval(
      [
        {
          id: "after-k",
          question: "q",
          expectedEvidence: [evidence()],
          matches: [
            match({ sectionId: "1" }),
            match({ sectionId: "2" }),
            match({ sectionId: "3" }),
            match({ sectionId: "4" }),
            match({ sectionId: "5" }),
            match(),
          ],
        },
      ],
      5,
    );
    expect(result).toMatchObject({ hitAtK: 0, recallAtK: 0, meanReciprocalRankAtK: 0 });
    expect(result.results[0].matches).toHaveLength(5);
  });

  it("should reject an empty suite, invalid K, or a case without gold evidence", () => {
    expect(() => evaluateRetrieval([], 5)).toThrow("at least one case");
    expect(() =>
      evaluateRetrieval([{ id: "x", question: "q", expectedEvidence: [evidence()], matches: [] }], 0),
    ).toThrow("positive integer");
    expect(() => evaluateRetrieval([{ id: "x", question: "q", expectedEvidence: [], matches: [] }], 5)).toThrow(
      "has no expected evidence",
    );
  });
});
