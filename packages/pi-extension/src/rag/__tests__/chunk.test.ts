import { describe, expect, it } from "vitest";
import { buildGuidelineChunks, cleanPageText, splitWithOverlap } from "../chunk";
import type { GuidelineDescriptor } from "../types";

const descriptor: GuidelineDescriptor = {
  checksum: "abc123",
  pdfPath: "/policies/guideline.pdf",
  metaPath: "/policies/guideline.meta.json",
  metadata: {
    id: "expense-policy",
    title: "Employee Expense Policy",
    organization: "Acme",
    version: "2026.1",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    jurisdiction: "CN",
    policyType: "general",
    contentStartPage: 8,
    printedPageOffset: 7,
  },
};

describe("cleanPageText()", () => {
  it("should normalize full-width text, whitespace, blank lines, and the printed page footer", () => {
    expect(cleanPageText(" １．　交通费\r\n\t凭票   报销\r\n\r\n  3  ", 3)).toBe("1. 交通费\n凭票 报销");
  });
});

describe("buildGuidelineChunks()", () => {
  it("should split numbered policy sections and attach verifiable page metadata", () => {
    const chunks = buildGuidelineChunks(descriptor, [
      { pageNumber: 8, ocr: false, text: "1. 开票资料\n发票抬头应正确。\n2、差旅费\n住宿费应提供发票。\n1" },
    ]);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      documentId: "expense-policy",
      sectionId: "1",
      section: "开票资料",
      pageStart: 8,
      pageEnd: 8,
      printedPageStart: 1,
      printedPageEnd: 1,
      text: "1. 开票资料\n发票抬头应正确。",
    });
    expect(chunks[1]).toMatchObject({
      sectionId: "2",
      section: "差旅费",
      text: "2、差旅费\n住宿费应提供发票。",
    });
    expect(chunks[1].embeddingText).toContain("Organization: Acme");
    expect(chunks[1].embeddingText).toContain("Section 2: 差旅费");
    expect(chunks[1].embeddingText).toContain("PDF page 8; printed page 1");
  });

  it("should carry the latest section context onto the following page", () => {
    const chunks = buildGuidelineChunks(descriptor, [
      { pageNumber: 8, ocr: false, text: "3. 会议费\n会议通知是必要材料。" },
      { pageNumber: 9, ocr: false, text: "还应提供参会人员名单。" },
    ]);
    expect(chunks[1]).toMatchObject({ sectionId: "3", section: "会议费", pageStart: 9, printedPageStart: 2 });
  });

  it("should omit heading-only noise while carrying that heading into later content", () => {
    const chunks = buildGuidelineChunks(descriptor, [
      { pageNumber: 8, ocr: false, text: "第一部分 报销管理\n2. 平台网址" },
      { pageNumber: 9, ocr: false, text: "https://finance.example" },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ sectionId: "2", section: "平台网址", text: "https://finance.example" });
  });

  it("should recognize a Chinese top-level heading without inventing a section number", () => {
    const [chunk] = buildGuidelineChunks(descriptor, [
      { pageNumber: 8, ocr: false, text: "一、 总则\n所有报销应真实、合理。" },
    ]);
    expect(chunk).toMatchObject({ sectionId: null, section: "一、 总则" });
  });

  it("should produce stable IDs and change them when the source checksum changes", () => {
    const pages = [{ pageNumber: 8, ocr: false, text: "1. 交通费\n据实报销。" }];
    const first = buildGuidelineChunks(descriptor, pages)[0].id;
    expect(buildGuidelineChunks(descriptor, pages)[0].id).toBe(first);
    expect(buildGuidelineChunks({ ...descriptor, checksum: "different" }, pages)[0].id).not.toBe(first);
  });

  it("should split a long section into bounded overlapping chunks", () => {
    const sentence = "本条要求提供真实有效的报销凭证。";
    const text = `4. 凭证要求\n${sentence.repeat(150)}`;
    const chunks = buildGuidelineChunks(descriptor, [{ pageNumber: 8, ocr: false, text }]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 1_200)).toBe(true);
    expect(chunks[0].text.slice(-40)).toContain(chunks[1].text.slice(0, 20));
  });

  it("should reject pages without indexable text", () => {
    expect(() => buildGuidelineChunks(descriptor, [{ pageNumber: 8, ocr: false, text: " \n1\n" }])).toThrow(
      "produced no content",
    );
  });
});

describe("splitWithOverlap()", () => {
  it("should return short text unchanged", () => {
    expect(splitWithOverlap("short policy", 20, 5)).toEqual(["short policy"]);
  });

  it("should fall back to the hard boundary when no sentence break exists", () => {
    expect(splitWithOverlap("abcdefghijkl", 8, 2)).toEqual(["abcdefgh", "ghijkl"]);
  });

  it("should prefer the latest sentence boundary in the safe part of a chunk", () => {
    const chunks = splitWithOverlap("甲甲甲甲甲甲。乙乙乙乙乙乙乙乙", 10, 2);
    expect(chunks[0]).toBe("甲甲甲甲甲甲。");
    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
  });

  it("should reject invalid size settings", () => {
    expect(() => splitWithOverlap("text", 0, 0)).toThrow("maxChars must be positive");
    expect(() => splitWithOverlap("text", 10, -1)).toThrow("overlapChars");
    expect(() => splitWithOverlap("text", 10, 10)).toThrow("overlapChars");
  });
});
