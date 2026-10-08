import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractFile } from "../files";
import type { GuidelineDescriptor, GuidelineMetadata, GuidelinePage } from "./types";

export const POLICY_DIR_ENV = "ACCOUNTANT24_POLICY_DIR";
export const GUIDELINE_PDF_NAME = "guideline.pdf";
export const GUIDELINE_META_NAME = "guideline.meta.json";

export interface GuidelinePaths {
  metaPath: string;
  pdfPath: string;
}

type FileExtractor = typeof extractFile;

const requiredStrings: ReadonlyArray<keyof GuidelineMetadata> = [
  "id",
  "title",
  "organization",
  "version",
  "effectiveFrom",
  "jurisdiction",
  "policyType",
];

export function resolveGuidelinePaths(env: NodeJS.ProcessEnv = process.env): GuidelinePaths {
  const policyDir = env[POLICY_DIR_ENV]?.trim();
  if (!policyDir) {
    throw new Error(`${POLICY_DIR_ENV} is not set; the bundled reimbursement guideline is unavailable.`);
  }
  return {
    pdfPath: join(policyDir, GUIDELINE_PDF_NAME),
    metaPath: join(policyDir, GUIDELINE_META_NAME),
  };
}

export function parseGuidelineMetadata(input: unknown): GuidelineMetadata {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Guideline metadata must be a JSON object.");
  }
  const value = input as Record<string, unknown>;
  for (const field of requiredStrings) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`Guideline metadata field '${field}' must be a non-empty string.`);
    }
  }
  if (value.effectiveTo !== null && typeof value.effectiveTo !== "string") {
    throw new Error("Guideline metadata field 'effectiveTo' must be a string or null.");
  }
  for (const field of ["contentStartPage", "printedPageOffset"] as const) {
    const number = value[field];
    if (!Number.isInteger(number) || (number as number) < (field === "contentStartPage" ? 1 : 0)) {
      throw new Error(`Guideline metadata field '${field}' is invalid.`);
    }
  }
  return value as unknown as GuidelineMetadata;
}

export async function loadGuidelineDescriptor(paths = resolveGuidelinePaths()): Promise<GuidelineDescriptor> {
  let pdf: Buffer;
  let metadataBytes: Buffer;
  try {
    [pdf, metadataBytes] = await Promise.all([readFile(paths.pdfPath), readFile(paths.metaPath)]);
  } catch (error) {
    throw new Error(`Unable to read the bundled reimbursement guideline: ${errorMessage(error)}`, { cause: error });
  }

  let metadataJson: unknown;
  try {
    metadataJson = JSON.parse(metadataBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Unable to parse ${GUIDELINE_META_NAME}: ${errorMessage(error)}`, { cause: error });
  }

  const metadata = parseGuidelineMetadata(metadataJson);
  const checksum = createHash("sha256").update(pdf).update("\0").update(metadataBytes).digest("hex");
  return { ...paths, checksum, metadata };
}

export function parseExtractedPages(text: string): GuidelinePage[] {
  const marker = /^--- Page (\d+)( \(OCR\))? ---\s*$/gm;
  const matches = [...text.matchAll(marker)];
  if (matches.length === 0) throw new Error("Extracted guideline text does not contain page markers.");

  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    return {
      pageNumber: Number(match[1]),
      ocr: Boolean(match[2]),
      text: text.slice(start, end).trim(),
    };
  });
}

export async function extractGuidelinePages(
  descriptor: GuidelineDescriptor,
  extractor: FileExtractor = extractFile,
): Promise<GuidelinePage[]> {
  const extracted = await extractor(descriptor.pdfPath);
  if (extracted.mimeType !== "application/pdf") {
    throw new Error(`Bundled guideline is not a PDF: ${extracted.mimeType}`);
  }
  const pages = parseExtractedPages(extracted.text).filter(
    (page) => page.pageNumber >= descriptor.metadata.contentStartPage,
  );
  if (pages.length === 0) throw new Error("Bundled guideline contains no indexable content pages.");
  return pages;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
