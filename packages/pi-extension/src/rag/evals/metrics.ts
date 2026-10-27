import type { GuidelineMatch } from "../types";

export interface ExpectedEvidence {
  page: number;
  printedPage: number | null;
  section: string;
}

export interface RetrievalEvaluationInput {
  expectedEvidence: ExpectedEvidence[];
  id: string;
  matches: GuidelineMatch[];
  question: string;
}

export interface RetrievalCaseMetrics extends RetrievalEvaluationInput {
  firstRelevantRank: number | null;
  hit: boolean;
  matchedEvidence: ExpectedEvidence[];
  reciprocalRank: number;
  recall: number;
}

export interface RetrievalMetrics {
  caseCount: number;
  hitAtK: number;
  hitCount: number;
  k: number;
  meanReciprocalRankAtK: number;
  recallAtK: number;
  results: RetrievalCaseMetrics[];
}

export function evaluateRetrieval(cases: RetrievalEvaluationInput[], k: number): RetrievalMetrics {
  if (!Number.isInteger(k) || k < 1) throw new Error("k must be a positive integer.");
  if (cases.length === 0) throw new Error("Retrieval evaluation requires at least one case.");

  const results = cases.map((testCase) => evaluateCase(testCase, k));
  const hitCount = results.filter((result) => result.hit).length;
  return {
    k,
    caseCount: results.length,
    hitCount,
    hitAtK: hitCount / results.length,
    recallAtK: mean(results.map((result) => result.recall)),
    meanReciprocalRankAtK: mean(results.map((result) => result.reciprocalRank)),
    results,
  };
}

export function evidenceMatches(expected: ExpectedEvidence, actual: GuidelineMatch): boolean {
  if (expected.page < actual.pageStart || expected.page > actual.pageEnd) return false;
  const normalizedPath = normalizeSection(expected.section);
  const expectedSection = normalizedPath.split("/").at(-1) ?? normalizedPath;
  if (/^\d+$/.test(expectedSection)) return actual.sectionId === expectedSection;
  return normalizeSection(actual.section) === expectedSection;
}

function evaluateCase(testCase: RetrievalEvaluationInput, k: number): RetrievalCaseMetrics {
  if (testCase.expectedEvidence.length === 0) {
    throw new Error(`Evaluation case '${testCase.id}' has no expected evidence.`);
  }
  const matches = testCase.matches.slice(0, k);
  const matchedEvidence = testCase.expectedEvidence.filter((expected) =>
    matches.some((actual) => evidenceMatches(expected, actual)),
  );
  const firstRelevantIndex = matches.findIndex((actual) =>
    testCase.expectedEvidence.some((expected) => evidenceMatches(expected, actual)),
  );
  const firstRelevantRank = firstRelevantIndex === -1 ? null : firstRelevantIndex + 1;
  return {
    ...testCase,
    matches,
    hit: matchedEvidence.length > 0,
    recall: matchedEvidence.length / testCase.expectedEvidence.length,
    reciprocalRank: firstRelevantRank === null ? 0 : 1 / firstRelevantRank,
    firstRelevantRank,
    matchedEvidence,
  };
}

function normalizeSection(section: string): string {
  return section.normalize("NFKC").replace(/\s+/g, "").trim();
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
