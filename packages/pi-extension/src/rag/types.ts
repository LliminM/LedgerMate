export interface GuidelineMetadata {
  id: string;
  title: string;
  organization: string;
  version: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  jurisdiction: string;
  policyType: string;
  contentStartPage: number;
  printedPageOffset: number;
}

export interface GuidelineDescriptor {
  checksum: string;
  metaPath: string;
  metadata: GuidelineMetadata;
  pdfPath: string;
}

export interface GuidelinePage {
  ocr: boolean;
  pageNumber: number;
  text: string;
}

export interface GuidelineChunk {
  chunkIndex: number;
  documentId: string;
  embeddingText: string;
  id: string;
  pageEnd: number;
  pageStart: number;
  printedPageEnd: number;
  printedPageStart: number;
  section: string;
  sectionId: string | null;
  sourceChecksum: string;
  text: string;
  title: string;
  version: string;
}

export interface GuidelineMatch {
  chunkId: string;
  distance: number | null;
  pageEnd: number;
  pageStart: number;
  printedPageEnd: number;
  printedPageStart: number;
  section: string;
  sectionId: string | null;
  text: string;
  title: string;
  version: string;
}

export interface GuidelineSearchResult {
  indexRebuilt: boolean;
  matches: GuidelineMatch[];
  query: string;
}
