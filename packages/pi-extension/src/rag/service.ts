import { ChromaClient, type Collection, type CollectionMetadata, type Metadata } from "chromadb";
import { buildGuidelineChunks, GUIDELINE_CHUNKING_VERSION } from "./chunk";
import { createAlibabaEmbeddingProvider, type TextEmbedder } from "./embedding";
import { extractGuidelinePages, loadGuidelineDescriptor, resolveGuidelinePaths } from "./source";
import type { GuidelineChunk, GuidelineDescriptor, GuidelineMatch, GuidelineSearchResult } from "./types";

export const GUIDELINE_COLLECTION_NAME = "accountant24-reimbursement-guideline";
export const CHROMA_URL_ENV = "ACCOUNTANT24_CHROMA_URL";
const INDEX_STATUS_BUILDING = "building";
const INDEX_STATUS_READY = "ready";

type GuidelineCollection = Pick<Collection, "count" | "metadata" | "modify" | "query" | "upsert">;

export interface GuidelineChromaClient {
  deleteCollection(args: { name: string }): Promise<void>;
  getOrCreateCollection(args: {
    configuration?: { hnsw?: { space: "cosine" } };
    embeddingFunction?: null;
    metadata?: CollectionMetadata;
    name: string;
  }): Promise<GuidelineCollection>;
}

export interface GuidelineRagDependencies {
  buildChunks: typeof buildGuidelineChunks;
  client: GuidelineChromaClient;
  embedder: TextEmbedder;
  extractPages: typeof extractGuidelinePages;
  loadDescriptor: typeof loadGuidelineDescriptor;
}

interface ReadyIndex {
  chunkCount: number;
  collection: GuidelineCollection;
  rebuilt: boolean;
}

export class GuidelineRagService {
  private readonly deps: GuidelineRagDependencies;
  private indexing: Promise<ReadyIndex> | null = null;

  constructor(dependencies: GuidelineRagDependencies) {
    this.deps = dependencies;
  }

  ensureIndexed(signal?: AbortSignal): Promise<ReadyIndex> {
    if (this.indexing) return this.indexing;
    const operation = this.buildOrReuseIndex(signal);
    this.indexing = operation;
    void operation.then(
      () => {
        if (this.indexing === operation) this.indexing = null;
      },
      () => {
        if (this.indexing === operation) this.indexing = null;
      },
    );
    return operation;
  }

  async search(query: string, topK = 5, signal?: AbortSignal): Promise<GuidelineSearchResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new Error("Guideline search query must not be empty.");
    if (!Number.isInteger(topK) || topK < 1 || topK > 8) throw new Error("topK must be an integer from 1 to 8.");

    const index = await this.ensureIndexed(signal);
    const [queryEmbedding] = await this.deps.embedder.embed([normalizedQuery], signal);
    const result = await index.collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: Math.min(topK, index.chunkCount),
      include: ["documents", "metadatas", "distances"],
    });
    const matches: GuidelineMatch[] = [];
    const ids = result.ids[0] ?? [];
    for (let index = 0; index < ids.length; index++) {
      const document = result.documents[0]?.[index];
      const metadata = result.metadatas[0]?.[index];
      if (typeof document !== "string" || !metadata) continue;
      matches.push(matchFromRecord(ids[index], document, metadata, result.distances[0]?.[index] ?? null));
    }
    return { query: normalizedQuery, indexRebuilt: index.rebuilt, matches };
  }

  private async buildOrReuseIndex(signal?: AbortSignal): Promise<ReadyIndex> {
    const descriptor = await this.deps.loadDescriptor();
    let collection = await this.deps.client.getOrCreateCollection({
      name: GUIDELINE_COLLECTION_NAME,
      configuration: { hnsw: { space: "cosine" } },
      embeddingFunction: null,
      metadata: collectionMetadata(descriptor, this.deps.embedder, INDEX_STATUS_BUILDING, 0),
    });
    const expectedCount = optionalMetadataNumber(collection.metadata, "chunkCount");
    if (
      isCurrentIndex(collection.metadata, descriptor, this.deps.embedder) &&
      expectedCount !== null &&
      expectedCount > 0
    ) {
      const actualCount = await collection.count();
      if (actualCount === expectedCount) return { collection, chunkCount: actualCount, rebuilt: false };
    }

    const pages = await this.deps.extractPages(descriptor);
    const chunks = this.deps.buildChunks(descriptor, pages);
    await this.deps.client.deleteCollection({ name: GUIDELINE_COLLECTION_NAME });
    collection = await this.deps.client.getOrCreateCollection({
      name: GUIDELINE_COLLECTION_NAME,
      configuration: { hnsw: { space: "cosine" } },
      embeddingFunction: null,
      metadata: collectionMetadata(descriptor, this.deps.embedder, INDEX_STATUS_BUILDING, chunks.length),
    });

    const batchSize = Math.min(this.deps.embedder.maxBatchSize, 10);
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error("Embedding provider maxBatchSize must be a positive integer.");
    }
    for (let offset = 0; offset < chunks.length; offset += batchSize) {
      const batch = chunks.slice(offset, offset + batchSize);
      const embeddings = await this.deps.embedder.embed(
        batch.map((chunk) => chunk.embeddingText),
        signal,
      );
      await collection.upsert({
        ids: batch.map((chunk) => chunk.id),
        embeddings,
        documents: batch.map((chunk) => chunk.text),
        metadatas: batch.map(chunkMetadata),
        uris: batch.map((chunk) => `guideline.pdf#page=${chunk.pageStart}`),
      });
    }
    await collection.modify({
      metadata: collectionMetadata(descriptor, this.deps.embedder, INDEX_STATUS_READY, chunks.length),
    });
    return { collection, chunkCount: chunks.length, rebuilt: true };
  }
}

export function parseLocalChromaUrl(value: string | undefined): { host: string; port: number; ssl: false } {
  if (!value) throw new Error(`${CHROMA_URL_ENV} is not set; local Chroma is unavailable.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${CHROMA_URL_ENV} is not a valid URL.`);
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
    throw new Error(`${CHROMA_URL_ENV} must be an http://127.0.0.1:<port> URL.`);
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${CHROMA_URL_ENV} has an invalid port.`);
  return { host: url.hostname, port, ssl: false };
}

export function createGuidelineRagService(env: NodeJS.ProcessEnv = process.env): GuidelineRagService {
  const client = new ChromaClient(parseLocalChromaUrl(env[CHROMA_URL_ENV]));
  return new GuidelineRagService({
    client,
    embedder: createAlibabaEmbeddingProvider(env),
    loadDescriptor: () => loadGuidelineDescriptor(resolveGuidelinePaths(env)),
    extractPages: extractGuidelinePages,
    buildChunks: buildGuidelineChunks,
  });
}

let defaultService: GuidelineRagService | null = null;

export function getGuidelineRagService(): GuidelineRagService {
  defaultService ??= createGuidelineRagService();
  return defaultService;
}

function collectionMetadata(
  descriptor: GuidelineDescriptor,
  embedder: TextEmbedder,
  status: string,
  chunkCount: number,
): CollectionMetadata {
  return {
    documentId: descriptor.metadata.id,
    documentTitle: descriptor.metadata.title,
    documentVersion: descriptor.metadata.version,
    sourceChecksum: descriptor.checksum,
    chunkingVersion: GUIDELINE_CHUNKING_VERSION,
    embeddingModel: embedder.model,
    embeddingDimensions: embedder.dimensions,
    indexStatus: status,
    chunkCount,
  };
}

function isCurrentIndex(
  metadata: CollectionMetadata | undefined,
  descriptor: GuidelineDescriptor,
  embedder: TextEmbedder,
): boolean {
  return (
    metadata?.indexStatus === INDEX_STATUS_READY &&
    metadata.sourceChecksum === descriptor.checksum &&
    metadata.documentVersion === descriptor.metadata.version &&
    metadata.chunkingVersion === GUIDELINE_CHUNKING_VERSION &&
    metadata.embeddingModel === embedder.model &&
    metadata.embeddingDimensions === embedder.dimensions
  );
}

function chunkMetadata(chunk: GuidelineChunk): Metadata {
  return {
    documentId: chunk.documentId,
    title: chunk.title,
    version: chunk.version,
    sourceChecksum: chunk.sourceChecksum,
    section: chunk.section,
    sectionId: chunk.sectionId,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    printedPageStart: chunk.printedPageStart,
    printedPageEnd: chunk.printedPageEnd,
    chunkIndex: chunk.chunkIndex,
  };
}

function matchFromRecord(id: string, text: string, metadata: Metadata, distance: number | null): GuidelineMatch {
  return {
    chunkId: id,
    text,
    distance,
    title: metadataString(metadata, "title"),
    version: metadataString(metadata, "version"),
    section: metadataString(metadata, "section"),
    sectionId: typeof metadata.sectionId === "string" && metadata.sectionId ? metadata.sectionId : null,
    pageStart: metadataNumber(metadata, "pageStart"),
    pageEnd: metadataNumber(metadata, "pageEnd"),
    printedPageStart: metadataNumber(metadata, "printedPageStart"),
    printedPageEnd: metadataNumber(metadata, "printedPageEnd"),
  };
}

function metadataString(metadata: Metadata | CollectionMetadata | undefined, key: string): string {
  const value = metadata?.[key];
  if (typeof value !== "string") throw new Error(`Chroma metadata '${key}' is missing or invalid.`);
  return value;
}

function metadataNumber(metadata: Metadata | CollectionMetadata | undefined, key: string): number {
  const value = metadata?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Chroma metadata '${key}' is missing or invalid.`);
  }
  return value;
}

function optionalMetadataNumber(metadata: CollectionMetadata | undefined, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
