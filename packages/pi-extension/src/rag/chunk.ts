import { createHash } from "node:crypto";
import type { GuidelineChunk, GuidelineDescriptor, GuidelinePage } from "./types";

export const GUIDELINE_CHUNKING_VERSION = "policy-sections-v1";
export const GUIDELINE_CHUNK_MAX_CHARS = 1_200;
export const GUIDELINE_CHUNK_OVERLAP_CHARS = 160;

interface SectionContext {
  id: string | null;
  title: string;
}

interface PageSegment extends SectionContext {
  text: string;
}

const NUMBERED_HEADING = /^(\d{1,3})\s*[.、]\s*(.+)$/;
const TOP_LEVEL_HEADING = /^(第[一二三四五六七八九十]+部分\s+.+|[一二三四五六七八九十]+、\s*.+|.+标准表)$/;
const BREAK_CHARACTERS = ["\n", "。", "；", "！", "？", ".", ";", "!", "?"];

export function buildGuidelineChunks(descriptor: GuidelineDescriptor, pages: GuidelinePage[]): GuidelineChunk[] {
  const chunks: GuidelineChunk[] = [];
  let currentSection: SectionContext = { id: null, title: descriptor.metadata.title };

  for (const page of pages) {
    const cleaned = cleanPageText(page.text, page.pageNumber - descriptor.metadata.printedPageOffset);
    if (!cleaned) continue;
    const segmented = segmentPage(cleaned, currentSection);
    currentSection = segmented.currentSection;

    for (const segment of segmented.segments) {
      if (isHeadingOnly(segment.text)) continue;
      for (const part of splitWithOverlap(segment.text)) {
        const chunkIndex = chunks.length;
        const printedPage = page.pageNumber - descriptor.metadata.printedPageOffset;
        const section = segment.title;
        const idInput = [
          descriptor.metadata.id,
          descriptor.metadata.version,
          descriptor.checksum,
          page.pageNumber,
          section,
          chunkIndex,
          part,
        ].join("\0");
        const id = createHash("sha256").update(idInput).digest("hex").slice(0, 32);
        const citation = segment.id ? `Section ${segment.id}: ${section}` : section;
        chunks.push({
          id,
          chunkIndex,
          documentId: descriptor.metadata.id,
          title: descriptor.metadata.title,
          version: descriptor.metadata.version,
          sourceChecksum: descriptor.checksum,
          section,
          sectionId: segment.id,
          pageStart: page.pageNumber,
          pageEnd: page.pageNumber,
          printedPageStart: printedPage,
          printedPageEnd: printedPage,
          text: part,
          embeddingText: [
            `Document: ${descriptor.metadata.title}`,
            `Organization: ${descriptor.metadata.organization}`,
            citation,
            `PDF page ${page.pageNumber}; printed page ${printedPage}`,
            part,
          ].join("\n"),
        });
      }
    }
  }

  if (chunks.length === 0) throw new Error("Guideline chunking produced no content.");
  return chunks;
}

function isHeadingOnly(text: string): boolean {
  if (text.includes("\n")) return false;
  return NUMBERED_HEADING.test(text) || TOP_LEVEL_HEADING.test(text);
}

export function cleanPageText(text: string, printedPage: number): string {
  const normalized = text.normalize("NFKC").replace(/\r\n?/g, "\n");
  return normalized
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter((line) => line.length > 0 && line !== String(printedPage))
    .join("\n")
    .trim();
}

function segmentPage(
  text: string,
  initialSection: SectionContext,
): {
  currentSection: SectionContext;
  segments: PageSegment[];
} {
  const segments: PageSegment[] = [];
  let section = initialSection;
  let lines: string[] = [];

  const flush = () => {
    const body = lines.join("\n").trim();
    if (body) segments.push({ ...section, text: body });
    lines = [];
  };

  for (const line of text.split("\n")) {
    const numbered = line.match(NUMBERED_HEADING);
    if (numbered) {
      flush();
      section = { id: numbered[1], title: numbered[2].trim() };
      lines.push(line);
      continue;
    }
    if (TOP_LEVEL_HEADING.test(line)) {
      flush();
      section = { id: null, title: line };
      lines.push(line);
      continue;
    }
    lines.push(line);
  }
  flush();
  return { currentSection: section, segments };
}

export function splitWithOverlap(
  text: string,
  maxChars = GUIDELINE_CHUNK_MAX_CHARS,
  overlapChars = GUIDELINE_CHUNK_OVERLAP_CHARS,
): string[] {
  if (maxChars < 1) throw new Error("maxChars must be positive.");
  if (overlapChars < 0 || overlapChars >= maxChars) {
    throw new Error("overlapChars must be non-negative and smaller than maxChars.");
  }
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = Math.min(start + maxChars, text.length);
    let preferredEnd = 0;
    if (hardEnd < text.length) {
      const minimumBreak = start + Math.floor(maxChars * 0.6);
      for (const character of BREAK_CHARACTERS) {
        const candidate = text.lastIndexOf(character, hardEnd - 1) + 1;
        if (candidate >= minimumBreak) preferredEnd = Math.max(preferredEnd, candidate);
      }
    }
    const end = preferredEnd || hardEnd;
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlapChars);
    while (start < end && /\s/.test(text[start])) start++;
  }
  return chunks;
}
