import { describe, expect, it, vi } from "vitest";
import {
  CHROMA_URL_ENV,
  createGuidelineRagService,
  GUIDELINE_COLLECTION_NAME,
  type GuidelineRagDependencies,
  GuidelineRagService,
  getGuidelineRagService,
  parseLocalChromaUrl,
} from "../service";
import type { GuidelineChunk, GuidelineDescriptor } from "../types";

const descriptor: GuidelineDescriptor = {
  checksum: "source-v1",
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

const chunk = (index: number): GuidelineChunk => ({
  id: `chunk-${index}`,
  chunkIndex: index,
  documentId: "expense-policy",
  title: "Employee Expense Policy",
  version: "2026.1",
  sourceChecksum: "source-v1",
  section: `Rule ${index}`,
  sectionId: String(index),
  pageStart: index + 8,
  pageEnd: index + 8,
  printedPageStart: index + 1,
  printedPageEnd: index + 1,
  text: `Policy text ${index}`,
  embeddingText: `Embedding text ${index}`,
});

const readyMetadata = {
  documentId: "expense-policy",
  documentTitle: "Employee Expense Policy",
  documentVersion: "2026.1",
  sourceChecksum: "source-v1",
  chunkingVersion: "policy-sections-v1",
  embeddingModel: "text-embedding-v4",
  embeddingDimensions: 1024,
  indexStatus: "ready",
  chunkCount: 2,
};

// The Chroma SDK's public QueryResult also exposes derived convenience fields;
// these fakes intentionally model only the fields consumed by our adapter.
function fakeCollection(metadata: Record<string, unknown> = readyMetadata): any {
  return {
    metadata,
    count: vi.fn(async () => 2),
    modify: vi.fn(async () => {}),
    query: vi.fn(async () => ({ ids: [[]], documents: [[]], metadatas: [[]], distances: [[]] })),
    upsert: vi.fn(async () => {}),
  };
}

function makeDependencies(overrides: Partial<GuidelineRagDependencies> = {}) {
  const existing = fakeCollection();
  const fresh = fakeCollection({ indexStatus: "building", chunkCount: 2 });
  const client = {
    deleteCollection: vi.fn(async () => {}),
    getOrCreateCollection: vi.fn(async () => existing),
  };
  const embedder = {
    model: "text-embedding-v4",
    dimensions: 1024,
    maxBatchSize: 10,
    embed: vi.fn(async (texts: string[]) => texts.map((_, index) => [index + 0.5])),
  };
  const dependencies: GuidelineRagDependencies = {
    client,
    embedder,
    loadDescriptor: vi.fn(async () => descriptor),
    extractPages: vi.fn(async () => [{ pageNumber: 8, ocr: false, text: "policy" }]),
    buildChunks: vi.fn(() => [chunk(0), chunk(1)]),
    ...overrides,
  };
  return { dependencies, existing, fresh, client, embedder };
}

describe("GuidelineRagService.ensureIndexed()", () => {
  it("should reuse a ready collection when checksum, versions, model, dimensions, and count match", async () => {
    const fixture = makeDependencies();
    const result = await new GuidelineRagService(fixture.dependencies).ensureIndexed();

    expect(result).toMatchObject({ chunkCount: 2, rebuilt: false, collection: fixture.existing });
    expect(fixture.existing.count).toHaveBeenCalledOnce();
    expect(fixture.dependencies.extractPages).not.toHaveBeenCalled();
    expect(fixture.client.deleteCollection).not.toHaveBeenCalled();
    expect(fixture.embedder.embed).not.toHaveBeenCalled();
  });

  it("should rebuild a stale collection, embed in API-sized batches, and mark it ready only at the end", async () => {
    const existing = fakeCollection({ ...readyMetadata, sourceChecksum: "old" });
    const fresh = fakeCollection({ indexStatus: "building", chunkCount: 12 });
    const chunks = Array.from({ length: 12 }, (_, index) => chunk(index));
    const client = {
      deleteCollection: vi.fn(async () => {}),
      getOrCreateCollection: vi.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(fresh),
    };
    const fixture = makeDependencies({ client, buildChunks: vi.fn(() => chunks) });
    const result = await new GuidelineRagService(fixture.dependencies).ensureIndexed();

    expect(result).toMatchObject({ chunkCount: 12, rebuilt: true, collection: fresh });
    expect(client.deleteCollection).toHaveBeenCalledWith({ name: GUIDELINE_COLLECTION_NAME });
    expect(fixture.embedder.embed).toHaveBeenCalledTimes(2);
    expect(fixture.embedder.embed.mock.calls[0][0]).toEqual(chunks.slice(0, 10).map((item) => item.embeddingText));
    expect(fixture.embedder.embed.mock.calls[1][0]).toEqual(chunks.slice(10).map((item) => item.embeddingText));
    expect(fresh.upsert).toHaveBeenCalledTimes(2);
    expect(fresh.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ids: chunks.slice(0, 10).map((item) => item.id),
        documents: chunks.slice(0, 10).map((item) => item.text),
        uris: chunks.slice(0, 10).map((item) => `guideline.pdf#page=${item.pageStart}`),
      }),
    );
    expect(fresh.modify).toHaveBeenCalledWith({
      metadata: expect.objectContaining({ indexStatus: "ready", chunkCount: 12, sourceChecksum: "source-v1" }),
    });
  });

  it("should rebuild when ready metadata has no valid chunk count", async () => {
    const existing = fakeCollection({ ...readyMetadata, chunkCount: "2" });
    const fresh = fakeCollection({ indexStatus: "building" });
    const client = {
      deleteCollection: vi.fn(async () => {}),
      getOrCreateCollection: vi.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(fresh),
    };
    const fixture = makeDependencies({ client });
    await expect(new GuidelineRagService(fixture.dependencies).ensureIndexed()).resolves.toMatchObject({
      rebuilt: true,
    });
    expect(existing.count).not.toHaveBeenCalled();
  });

  it("should rebuild when stored count does not equal the collection count", async () => {
    const fixture = makeDependencies();
    fixture.existing.count.mockResolvedValue(1);
    fixture.client.getOrCreateCollection.mockResolvedValueOnce(fixture.existing).mockResolvedValueOnce(fixture.fresh);
    await expect(new GuidelineRagService(fixture.dependencies).ensureIndexed()).resolves.toMatchObject({
      rebuilt: true,
    });
    expect(fixture.client.deleteCollection).toHaveBeenCalledOnce();
  });

  it("should reject an invalid embedding batch size before calling the API", async () => {
    const fixture = makeDependencies({
      embedder: { model: "text-embedding-v4", dimensions: 1024, maxBatchSize: 0, embed: vi.fn() },
    });
    fixture.client.getOrCreateCollection.mockResolvedValueOnce(fakeCollection({ indexStatus: "building" }));
    await expect(new GuidelineRagService(fixture.dependencies).ensureIndexed()).rejects.toThrow("maxBatchSize");
  });

  it("should share one in-flight indexing operation between concurrent callers", async () => {
    let release!: (value: GuidelineDescriptor) => void;
    const loadDescriptor = vi.fn(() => new Promise<GuidelineDescriptor>((resolve) => (release = resolve)));
    const fixture = makeDependencies({ loadDescriptor });
    const service = new GuidelineRagService(fixture.dependencies);
    const first = service.ensureIndexed();
    const second = service.ensureIndexed();
    expect(first).toBe(second);
    release(descriptor);
    await Promise.all([first, second]);
    expect(loadDescriptor).toHaveBeenCalledOnce();
  });

  it("should allow a retry after a failed index operation", async () => {
    const fixture = makeDependencies();
    fixture.dependencies.loadDescriptor = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary read failure"))
      .mockResolvedValueOnce(descriptor);
    const service = new GuidelineRagService(fixture.dependencies);
    await expect(service.ensureIndexed()).rejects.toThrow("temporary read failure");
    await expect(service.ensureIndexed()).resolves.toMatchObject({ rebuilt: false });
    expect(fixture.dependencies.loadDescriptor).toHaveBeenCalledTimes(2);
  });
});

describe("GuidelineRagService.search()", () => {
  it("should embed the normalized query, cap results to the indexed count, and map Chroma records", async () => {
    const fixture = makeDependencies();
    fixture.existing.query.mockResolvedValue({
      ids: [["chunk-1", "missing-document"]],
      documents: [["A hotel invoice is required.", null]],
      metadatas: [
        [
          {
            title: "Employee Expense Policy",
            version: "2026.1",
            section: "Travel",
            sectionId: "3",
            pageStart: 12,
            pageEnd: 12,
            printedPageStart: 5,
            printedPageEnd: 5,
          },
          null,
        ],
      ],
      distances: [[0.12, null]],
    });
    const service = new GuidelineRagService(fixture.dependencies);
    const result = await service.search("  hotel invoice  ", 8);

    expect(fixture.embedder.embed).toHaveBeenCalledWith(["hotel invoice"], undefined);
    expect(fixture.existing.query).toHaveBeenCalledWith({
      queryEmbeddings: [[0.5]],
      nResults: 2,
      include: ["documents", "metadatas", "distances"],
    });
    expect(result).toEqual({
      query: "hotel invoice",
      indexRebuilt: false,
      matches: [
        {
          chunkId: "chunk-1",
          text: "A hotel invoice is required.",
          distance: 0.12,
          title: "Employee Expense Policy",
          version: "2026.1",
          section: "Travel",
          sectionId: "3",
          pageStart: 12,
          pageEnd: 12,
          printedPageStart: 5,
          printedPageEnd: 5,
        },
      ],
    });
  });

  it("should accept a result without sectionId or distance", async () => {
    const fixture = makeDependencies();
    fixture.existing.query.mockResolvedValue({
      ids: [["chunk-1"]],
      documents: [["General rule"]],
      metadatas: [
        [
          {
            title: "Policy",
            version: "1",
            section: "General",
            sectionId: null,
            pageStart: 1,
            pageEnd: 2,
            printedPageStart: 1,
            printedPageEnd: 2,
          },
        ],
      ],
      distances: [[]],
    });
    await expect(new GuidelineRagService(fixture.dependencies).search("rule")).resolves.toMatchObject({
      matches: [{ sectionId: null, distance: null }],
    });
  });

  it.each([
    ["", 5, "must not be empty"],
    ["query", 0, "integer from 1 to 8"],
    ["query", 9, "integer from 1 to 8"],
    ["query", 1.5, "integer from 1 to 8"],
  ] as const)("should reject query=%j and topK=%s", async (query, topK, message) => {
    const fixture = makeDependencies();
    await expect(new GuidelineRagService(fixture.dependencies).search(query, topK)).rejects.toThrow(message);
  });

  it("should reject malformed match metadata instead of fabricating a citation", async () => {
    const fixture = makeDependencies();
    fixture.existing.query.mockResolvedValue({
      ids: [["chunk-1"]],
      documents: [["Rule"]],
      metadatas: [[{ title: "Policy" }]],
      distances: [[0.2]],
    });
    await expect(new GuidelineRagService(fixture.dependencies).search("rule")).rejects.toThrow(
      "metadata 'version' is missing",
    );
  });

  it("should reject a non-numeric page instead of fabricating a citation", async () => {
    const fixture = makeDependencies();
    fixture.existing.query.mockResolvedValue({
      ids: [["chunk-1"]],
      documents: [["Rule"]],
      metadatas: [
        [
          {
            title: "Policy",
            version: "1",
            section: "General",
            pageStart: "1",
            pageEnd: 1,
            printedPageStart: 1,
            printedPageEnd: 1,
          },
        ],
      ],
      distances: [[0.2]],
    });
    await expect(new GuidelineRagService(fixture.dependencies).search("rule")).rejects.toThrow(
      "metadata 'pageStart' is missing",
    );
  });
});

describe("parseLocalChromaUrl()", () => {
  it("should parse the loopback Chroma sidecar URL", () => {
    expect(parseLocalChromaUrl("http://127.0.0.1:43123")).toEqual({ host: "127.0.0.1", port: 43123, ssl: false });
  });

  it.each([
    [undefined, "is not set"],
    ["not-a-url", "not a valid URL"],
    ["https://127.0.0.1:43123", "must be an http://127.0.0.1"],
    ["http://localhost:43123", "must be an http://127.0.0.1"],
    ["http://127.0.0.1", "must be an http://127.0.0.1"],
    ["http://127.0.0.1:99999", "not a valid URL"],
  ] as const)("should reject %s", (url, message) => {
    expect(() => parseLocalChromaUrl(url)).toThrow(message);
  });
});

describe("createGuidelineRagService()", () => {
  it("should construct the production service from Chroma and DashScope environment settings", () => {
    expect(
      createGuidelineRagService({
        [CHROMA_URL_ENV]: "http://127.0.0.1:43123",
        DASHSCOPE_API_KEY: "key",
        DASHSCOPE_BASE_URL: "https://dashscope.example/v1",
      }),
    ).toBeInstanceOf(GuidelineRagService);
  });

  it("should lazily create and then reuse the process-wide service", () => {
    const previous = {
      chroma: process.env[CHROMA_URL_ENV],
      key: process.env.DASHSCOPE_API_KEY,
      baseURL: process.env.DASHSCOPE_BASE_URL,
    };
    process.env[CHROMA_URL_ENV] = "http://127.0.0.1:43124";
    process.env.DASHSCOPE_API_KEY = "key";
    process.env.DASHSCOPE_BASE_URL = "https://dashscope.example/v1";
    try {
      const first = getGuidelineRagService();
      expect(getGuidelineRagService()).toBe(first);
    } finally {
      restoreEnvironment(CHROMA_URL_ENV, previous.chroma);
      restoreEnvironment("DASHSCOPE_API_KEY", previous.key);
      restoreEnvironment("DASHSCOPE_BASE_URL", previous.baseURL);
    }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
