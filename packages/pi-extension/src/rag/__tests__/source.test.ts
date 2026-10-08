import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractGuidelinePages,
  loadGuidelineDescriptor,
  parseExtractedPages,
  parseGuidelineMetadata,
  resolveGuidelinePaths,
} from "../source";

const validMetadata = {
  id: "policy",
  title: "Expense Policy",
  organization: "Acme",
  version: "1.0",
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  jurisdiction: "CN",
  policyType: "general",
  contentStartPage: 3,
  printedPageOffset: 2,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("resolveGuidelinePaths()", () => {
  it("should resolve both bundled files below ACCOUNTANT24_POLICY_DIR", () => {
    expect(resolveGuidelinePaths({ ACCOUNTANT24_POLICY_DIR: " /app/policies " })).toEqual({
      pdfPath: "/app/policies/guideline.pdf",
      metaPath: "/app/policies/guideline.meta.json",
    });
  });

  it("should reject a missing policy directory", () => {
    expect(() => resolveGuidelinePaths({})).toThrow("ACCOUNTANT24_POLICY_DIR is not set");
  });
});

describe("parseGuidelineMetadata()", () => {
  it("should accept complete version and page metadata", () => {
    expect(parseGuidelineMetadata(validMetadata)).toEqual(validMetadata);
  });

  it("should accept a string effectiveTo date", () => {
    expect(parseGuidelineMetadata({ ...validMetadata, effectiveTo: "2026-12-31" }).effectiveTo).toBe("2026-12-31");
  });

  it.each([null, [], "metadata"])("should reject a non-object value %#", (value) => {
    expect(() => parseGuidelineMetadata(value)).toThrow("must be a JSON object");
  });

  it.each([
    "id",
    "title",
    "organization",
    "version",
    "effectiveFrom",
    "jurisdiction",
    "policyType",
  ] as const)("should reject missing or empty '%s'", (field) => {
    expect(() => parseGuidelineMetadata({ ...validMetadata, [field]: "" })).toThrow(`field '${field}'`);
  });

  it("should reject a non-string effectiveTo", () => {
    expect(() => parseGuidelineMetadata({ ...validMetadata, effectiveTo: 2027 })).toThrow("effectiveTo");
  });

  it.each([
    ["contentStartPage", 0],
    ["contentStartPage", 1.5],
    ["printedPageOffset", -1],
    ["printedPageOffset", "2"],
  ] as const)("should reject invalid %s=%s", (field, value) => {
    expect(() => parseGuidelineMetadata({ ...validMetadata, [field]: value })).toThrow(`field '${field}' is invalid`);
  });
});

describe("loadGuidelineDescriptor()", () => {
  it("should read metadata and calculate a source checksum from both files", async () => {
    const paths = await writeGuideline(Buffer.from("pdf-v1"), validMetadata);
    const first = await loadGuidelineDescriptor(paths);
    await writeFile(paths.metaPath, JSON.stringify({ ...validMetadata, version: "2.0" }));
    const second = await loadGuidelineDescriptor(paths);

    expect(first.metadata).toEqual(validMetadata);
    expect(first.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(second.checksum).not.toBe(first.checksum);
  });

  it("should explain when a bundled file cannot be read", async () => {
    await expect(
      loadGuidelineDescriptor({ pdfPath: "/missing/guideline.pdf", metaPath: "/missing/guideline.meta.json" }),
    ).rejects.toThrow("Unable to read the bundled reimbursement guideline");
  });

  it("should explain malformed JSON metadata", async () => {
    const paths = await writeGuideline(Buffer.from("pdf"), validMetadata);
    await writeFile(paths.metaPath, "{");
    await expect(loadGuidelineDescriptor(paths)).rejects.toThrow("Unable to parse guideline.meta.json");
  });
});

describe("parseExtractedPages()", () => {
  it("should preserve PDF page numbers, OCR markers, and page text", () => {
    expect(parseExtractedPages("--- Page 1 ---\nCover\n\n--- Page 2 (OCR) ---\nRule text\n")).toEqual([
      { pageNumber: 1, ocr: false, text: "Cover" },
      { pageNumber: 2, ocr: true, text: "Rule text" },
    ]);
  });

  it("should reject extracted text without page markers", () => {
    expect(() => parseExtractedPages("plain text")).toThrow("does not contain page markers");
  });
});

describe("extractGuidelinePages()", () => {
  const descriptor = {
    checksum: "checksum",
    metadata: validMetadata,
    pdfPath: "/policies/guideline.pdf",
    metaPath: "/policies/guideline.meta.json",
  };

  it("should keep only content pages at and after contentStartPage", async () => {
    const extractor = async () => ({
      filePath: descriptor.pdfPath,
      mimeType: "application/pdf",
      pageCount: 4,
      text: "--- Page 1 ---\nCover\n--- Page 2 ---\nTOC\n--- Page 3 ---\nFirst rule\n--- Page 4 ---\nNext rule",
    });
    await expect(extractGuidelinePages(descriptor, extractor)).resolves.toEqual([
      { pageNumber: 3, ocr: false, text: "First rule" },
      { pageNumber: 4, ocr: false, text: "Next rule" },
    ]);
  });

  it("should reject a resource that is not detected as PDF", async () => {
    const extractor = async () => ({ filePath: descriptor.pdfPath, mimeType: "text/plain", text: "text" });
    await expect(extractGuidelinePages(descriptor, extractor)).rejects.toThrow("is not a PDF");
  });

  it("should reject a PDF with no pages after the configured start page", async () => {
    const extractor = async () => ({
      filePath: descriptor.pdfPath,
      mimeType: "application/pdf",
      text: "--- Page 1 ---\nCover",
    });
    await expect(extractGuidelinePages(descriptor, extractor)).rejects.toThrow("no indexable content pages");
  });
});

async function writeGuideline(pdf: Buffer, metadata: object): Promise<{ pdfPath: string; metaPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "accountant24-guideline-"));
  temporaryDirectories.push(directory);
  const paths = { pdfPath: join(directory, "guideline.pdf"), metaPath: join(directory, "guideline.meta.json") };
  await Promise.all([writeFile(paths.pdfPath, pdf), writeFile(paths.metaPath, JSON.stringify(metadata))]);
  return paths;
}
