import OpenAI from "openai";

export const ALIBABA_EMBEDDING_MODEL = "text-embedding-v4";
export const ALIBABA_EMBEDDING_DIMENSIONS = 1_024;
export const ALIBABA_EMBEDDING_BATCH_SIZE = 10;
export const DASHSCOPE_API_KEY_ENV = "DASHSCOPE_API_KEY";
export const DASHSCOPE_BASE_URL_ENV = "DASHSCOPE_BASE_URL";

export interface TextEmbedder {
  readonly dimensions: number;
  readonly maxBatchSize: number;
  readonly model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

export interface EmbeddingApi {
  create(
    request: {
      dimensions: number;
      encoding_format: "float";
      input: string[];
      model: string;
    },
    signal?: AbortSignal,
  ): Promise<EmbeddingResponse>;
}

export interface AlibabaEmbeddingConfig {
  apiKey: string;
  baseURL: string;
}

export function readAlibabaEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): AlibabaEmbeddingConfig {
  const apiKey = env[DASHSCOPE_API_KEY_ENV]?.trim();
  if (!apiKey) throw new Error(`${DASHSCOPE_API_KEY_ENV} is not set.`);

  const rawBaseURL = env[DASHSCOPE_BASE_URL_ENV]?.trim();
  if (!rawBaseURL) {
    throw new Error(
      `${DASHSCOPE_BASE_URL_ENV} is not set. Use the OpenAI-compatible URL for your Alibaba Cloud region and workspace.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(rawBaseURL);
  } catch {
    throw new Error(`${DASHSCOPE_BASE_URL_ENV} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${DASHSCOPE_BASE_URL_ENV} must use HTTPS.`);
  }
  return { apiKey, baseURL: rawBaseURL.replace(/\/+$/, "") };
}

export class AlibabaEmbeddingProvider implements TextEmbedder {
  readonly dimensions = ALIBABA_EMBEDDING_DIMENSIONS;
  readonly maxBatchSize = ALIBABA_EMBEDDING_BATCH_SIZE;
  readonly model = ALIBABA_EMBEDDING_MODEL;

  constructor(private readonly api: EmbeddingApi) {}

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length > this.maxBatchSize) {
      throw new Error(`${this.model} accepts at most ${this.maxBatchSize} texts per request.`);
    }
    if (texts.some((text) => text.trim().length === 0)) throw new Error("Embedding input must not be empty.");

    const response = await this.api.create(
      {
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
        encoding_format: "float",
      },
      signal,
    );
    if (response.data.length !== texts.length) {
      throw new Error(`Embedding API returned ${response.data.length} vectors for ${texts.length} inputs.`);
    }
    const ordered = [...response.data].sort((left, right) => left.index - right.index);
    if (ordered.some((item, index) => item.index !== index)) {
      throw new Error("Embedding API returned invalid or duplicate vector indices.");
    }
    const vectors = ordered.map((item) => item.embedding);
    for (const vector of vectors) {
      if (vector.length !== this.dimensions || vector.some((value) => !Number.isFinite(value))) {
        throw new Error(`Embedding API returned an invalid ${this.dimensions}-dimension vector.`);
      }
    }
    return vectors;
  }
}

export function createAlibabaEmbeddingProvider(
  env: NodeJS.ProcessEnv = process.env,
  createClient: (config: AlibabaEmbeddingConfig) => OpenAI = (config) =>
    new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 2, timeout: 30_000 }),
): AlibabaEmbeddingProvider {
  const client = createClient(readAlibabaEmbeddingConfig(env));
  return new AlibabaEmbeddingProvider({
    create: async (request, signal) => client.embeddings.create(request, { signal }),
  });
}
