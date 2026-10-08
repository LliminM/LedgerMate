import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  ALIBABA_EMBEDDING_DIMENSIONS,
  AlibabaEmbeddingProvider,
  createAlibabaEmbeddingProvider,
  type EmbeddingApi,
  readAlibabaEmbeddingConfig,
} from "../embedding";

const vector = (value: number): number[] => Array.from({ length: ALIBABA_EMBEDDING_DIMENSIONS }, () => value);

describe("readAlibabaEmbeddingConfig()", () => {
  it("should trim credentials and remove trailing slashes from the HTTPS base URL", () => {
    expect(
      readAlibabaEmbeddingConfig({
        DASHSCOPE_API_KEY: " secret ",
        DASHSCOPE_BASE_URL: " https://example.cn/compatible-mode/v1/// ",
      }),
    ).toEqual({ apiKey: "secret", baseURL: "https://example.cn/compatible-mode/v1" });
  });

  it("should reject a missing API key", () => {
    expect(() => readAlibabaEmbeddingConfig({ DASHSCOPE_BASE_URL: "https://example.cn" })).toThrow(
      "DASHSCOPE_API_KEY is not set",
    );
  });

  it("should reject a missing base URL", () => {
    expect(() => readAlibabaEmbeddingConfig({ DASHSCOPE_API_KEY: "key" })).toThrow("DASHSCOPE_BASE_URL is not set");
  });

  it.each(["not a url", "http://example.cn/v1"])("should reject an unsafe or invalid base URL '%s'", (baseURL) => {
    expect(() => readAlibabaEmbeddingConfig({ DASHSCOPE_API_KEY: "key", DASHSCOPE_BASE_URL: baseURL })).toThrow(
      "DASHSCOPE_BASE_URL",
    );
  });
});

describe("AlibabaEmbeddingProvider.embed()", () => {
  it("should request fixed-model vectors, preserve input order by response index, and pass the abort signal", async () => {
    const create = vi.fn(async () => ({
      data: [
        { index: 1, embedding: vector(2) },
        { index: 0, embedding: vector(1) },
      ],
    }));
    const provider = new AlibabaEmbeddingProvider({ create });
    const controller = new AbortController();
    const result = await provider.embed(["first", "second"], controller.signal);

    expect(result[0][0]).toBe(1);
    expect(result[1][0]).toBe(2);
    expect(create).toHaveBeenCalledWith(
      {
        model: "text-embedding-v4",
        input: ["first", "second"],
        dimensions: 1024,
        encoding_format: "float",
      },
      controller.signal,
    );
  });

  it("should return an empty array without calling the API for empty input", async () => {
    const create = vi.fn();
    await expect(new AlibabaEmbeddingProvider({ create }).embed([])).resolves.toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("should reject blank input and a request larger than the API batch limit", async () => {
    const provider = new AlibabaEmbeddingProvider({ create: vi.fn() });
    await expect(provider.embed([" "])).rejects.toThrow("must not be empty");
    await expect(provider.embed(Array.from({ length: 11 }, (_, index) => `text-${index}`))).rejects.toThrow(
      "at most 10",
    );
  });

  it("should reject a response with the wrong number of vectors", async () => {
    const api: EmbeddingApi = { create: async () => ({ data: [] }) };
    await expect(new AlibabaEmbeddingProvider(api).embed(["one"])).rejects.toThrow("0 vectors for 1 inputs");
  });

  it("should reject duplicate or out-of-range response indices", async () => {
    const api: EmbeddingApi = {
      create: async () => ({
        data: [
          { index: 1, embedding: vector(1) },
          { index: 1, embedding: vector(2) },
        ],
      }),
    };
    await expect(new AlibabaEmbeddingProvider(api).embed(["one", "two"])).rejects.toThrow("duplicate vector indices");
  });

  it.each([
    [[1, 2, 3], "dimension"],
    [[...vector(1).slice(0, -1), Number.NaN], "non-finite"],
  ])("should reject a %s vector", async (embedding) => {
    const api: EmbeddingApi = { create: async () => ({ data: [{ index: 0, embedding: embedding as number[] }] }) };
    await expect(new AlibabaEmbeddingProvider(api).embed(["one"])).rejects.toThrow("invalid 1024-dimension vector");
  });
});

describe("createAlibabaEmbeddingProvider()", () => {
  it("should configure an OpenAI-compatible client and delegate embedding requests", async () => {
    const create = vi.fn(async () => ({ data: [{ index: 0, embedding: vector(7) }] }));
    const createClient = vi.fn(() => ({ embeddings: { create } }) as unknown as OpenAI);
    const provider = createAlibabaEmbeddingProvider(
      { DASHSCOPE_API_KEY: "key", DASHSCOPE_BASE_URL: "https://dashscope.example/v1" },
      createClient,
    );
    await expect(provider.embed(["policy"])).resolves.toEqual([vector(7)]);
    expect(createClient).toHaveBeenCalledWith({ apiKey: "key", baseURL: "https://dashscope.example/v1" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: "text-embedding-v4" }), { signal: undefined });
  });
});
