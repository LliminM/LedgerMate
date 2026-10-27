import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GUIDELINE_CHUNKING_VERSION } from "../src/rag/chunk";
import { ALIBABA_EMBEDDING_DIMENSIONS, ALIBABA_EMBEDDING_MODEL } from "../src/rag/embedding";
import { type ExpectedEvidence, evaluateRetrieval } from "../src/rag/evals/metrics";
import { createGuidelineRagService } from "../src/rag/service";
import { loadGuidelineDescriptor } from "../src/rag/source";

const TOP_K = 5;
const HOST = "127.0.0.1";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "../../..");
const POLICY_DIR = join(REPOSITORY_ROOT, "packages/desktop/resources/policies");
const CASES_PATH = join(SCRIPT_DIR, "../src/rag/evals/guideline-cases.json");
const OUTPUT_DIR = join(REPOSITORY_ROOT, "rag-eval-results");

interface GuidelineEvalCase {
  expectedEvidence?: ExpectedEvidence[];
  id: string;
  question: string;
}

interface TemporaryChroma {
  stop(): Promise<void>;
  url: string;
}

async function main(): Promise<void> {
  assertEnvironment();
  const cases = await loadCases();
  const chroma = await startTemporaryChroma();
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ACCOUNTANT24_CHROMA_URL: chroma.url,
      ACCOUNTANT24_POLICY_DIR: POLICY_DIR,
    };
    const service = createGuidelineRagService(env);
    const descriptor = await loadGuidelineDescriptor({
      pdfPath: join(POLICY_DIR, "guideline.pdf"),
      metaPath: join(POLICY_DIR, "guideline.meta.json"),
    });

    console.log(`Building a clean ${ALIBABA_EMBEDDING_MODEL} index in temporary Chroma...`);
    const index = await service.ensureIndexed();
    console.log(`Indexed ${index.chunkCount} chunks. Evaluating ${cases.length} cases at K=${TOP_K}...`);

    const inputs = [];
    for (const [position, testCase] of cases.entries()) {
      process.stdout.write(`[${position + 1}/${cases.length}] ${testCase.id} ... `);
      const result = await service.search(testCase.question, TOP_K);
      inputs.push({ ...testCase, matches: result.matches });
      console.log("done");
    }

    const metrics = evaluateRetrieval(inputs, TOP_K);
    const generatedAt = new Date().toISOString();
    const report = {
      generatedAt,
      configuration: {
        topK: TOP_K,
        embeddingModel: ALIBABA_EMBEDDING_MODEL,
        embeddingDimensions: ALIBABA_EMBEDDING_DIMENSIONS,
        chunkingVersion: GUIDELINE_CHUNKING_VERSION,
        documentId: descriptor.metadata.id,
        documentVersion: descriptor.metadata.version,
        sourceChecksum: descriptor.checksum,
        chunkCount: index.chunkCount,
      },
      metrics,
    };
    await mkdir(OUTPUT_DIR, { recursive: true });
    const jsonPath = join(OUTPUT_DIR, "guideline-retrieval.json");
    const markdownPath = join(OUTPUT_DIR, "guideline-retrieval.md");
    await Promise.all([
      writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
      writeFile(markdownPath, renderMarkdown(report)),
    ]);

    printSummary(metrics.hitAtK, metrics.recallAtK, metrics.meanReciprocalRankAtK, metrics.caseCount);
    console.log(`JSON report: ${jsonPath}`);
    console.log(`Markdown report: ${markdownPath}`);
  } catch (error) {
    throw enrichError(error);
  } finally {
    await chroma.stop();
  }
}

async function loadCases(): Promise<Array<GuidelineEvalCase & { expectedEvidence: ExpectedEvidence[] }>> {
  const parsed: unknown = JSON.parse(await readFile(CASES_PATH, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("guideline-cases.json must contain an array.");
  const cases: Array<GuidelineEvalCase & { expectedEvidence: ExpectedEvidence[] }> = [];
  for (const value of parsed) {
    if (!value || typeof value !== "object") throw new Error("Every guideline evaluation case must be an object.");
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.id !== "string" || typeof candidate.question !== "string") {
      throw new Error("Every guideline evaluation case requires string id and question fields.");
    }
    if (!Array.isArray(candidate.expectedEvidence) || candidate.expectedEvidence.length === 0) continue;
    const expectedEvidence = candidate.expectedEvidence.map(parseExpectedEvidence);
    cases.push({ id: candidate.id, question: candidate.question, expectedEvidence });
  }
  if (cases.length === 0) throw new Error("No evaluation cases with expected evidence were found.");
  return cases;
}

function parseExpectedEvidence(value: unknown): ExpectedEvidence {
  if (!value || typeof value !== "object") throw new Error("Expected evidence must be an object.");
  const evidence = value as Record<string, unknown>;
  if (typeof evidence.section !== "string" || !Number.isInteger(evidence.page)) {
    throw new Error("Expected evidence requires a string section and integer PDF page.");
  }
  if (evidence.printedPage !== null && !Number.isInteger(evidence.printedPage)) {
    throw new Error("Expected evidence printedPage must be an integer or null.");
  }
  return {
    section: evidence.section,
    page: evidence.page as number,
    printedPage: evidence.printedPage as number | null,
  };
}

async function startTemporaryChroma(): Promise<TemporaryChroma> {
  const dataDir = await mkdtemp(join(tmpdir(), "accountant24-rag-eval-"));
  const port = await findAvailablePort();
  const require = createRequire(import.meta.url);
  const cliPath = join(dirname(require.resolve("chromadb")), "..", "cli.mjs");
  const child = spawn(process.execPath, [cliPath, "run", "--path", dataDir, "--host", HOST, "--port", String(port)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let outputTail = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      outputTail = (outputTail + chunk).slice(-4_000);
    });
  }

  const url = `http://${HOST}:${port}`;
  try {
    await waitUntilReady(child, url);
  } catch (error) {
    await stopChild(child);
    await rm(dataDir, { recursive: true, force: true });
    throw new Error(`Temporary Chroma failed to start: ${errorMessage(error)}\n${outputTail.trim()}`, { cause: error });
  }
  return {
    url,
    async stop() {
      await stopChild(child);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate a Chroma port.")));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function waitUntilReady(child: ChildProcess, url: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Chroma exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${url}/api/v2/heartbeat`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The native server is still starting.
    }
    await delay(100);
  }
  throw new Error("Chroma did not answer its heartbeat within 15 seconds.");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())), delay(2_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function renderMarkdown(report: {
  configuration: {
    chunkCount: number;
    documentVersion: string;
    embeddingModel: string;
    sourceChecksum: string;
    topK: number;
  };
  generatedAt: string;
  metrics: ReturnType<typeof evaluateRetrieval>;
}): string {
  const { metrics, configuration } = report;
  const failures = metrics.results.filter((result) => result.recall < 1);
  const lines = [
    "# Guideline RAG Retrieval Evaluation",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Cases: ${metrics.caseCount}`,
    `- Model: \`${configuration.embeddingModel}\``,
    `- Document version: \`${configuration.documentVersion}\``,
    `- Source checksum: \`${configuration.sourceChecksum}\``,
    `- Chunks: ${configuration.chunkCount}`,
    `- K: ${configuration.topK}`,
    "",
    "## Metrics",
    "",
    "| Metric | Result |",
    "| --- | ---: |",
    `| Hit@${metrics.k} | ${formatPercent(metrics.hitAtK)} |`,
    `| Recall@${metrics.k} | ${formatPercent(metrics.recallAtK)} |`,
    `| MRR@${metrics.k} | ${metrics.meanReciprocalRankAtK.toFixed(4)} |`,
    "",
    "## Partial and missed cases",
    "",
  ];
  if (failures.length === 0) {
    lines.push("All expected evidence was retrieved.");
  } else {
    lines.push("| Case | Recall | First relevant rank | Retrieved citations |", "| --- | ---: | ---: | --- |");
    for (const result of failures) {
      const citations = result.matches
        .map((match) => `${match.sectionId ?? match.section} / PDF ${match.pageStart}`)
        .join("; ");
      lines.push(
        `| ${escapeCell(result.id)} | ${formatPercent(result.recall)} | ${result.firstRelevantRank ?? "—"} | ${escapeCell(citations)} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function printSummary(hit: number, recall: number, mrr: number, cases: number): void {
  console.log("\nRetrieval Evaluation");
  console.log("────────────────────────");
  console.log(`Cases:    ${cases}`);
  console.log(`Hit@${TOP_K}:    ${formatPercent(hit)}`);
  console.log(`Recall@${TOP_K}: ${formatPercent(recall)}`);
  console.log(`MRR@${TOP_K}:    ${mrr.toFixed(4)}`);
}

function assertEnvironment(): void {
  if (!process.env.DASHSCOPE_API_KEY?.trim()) throw new Error("DASHSCOPE_API_KEY is not set in this process.");
  if (!process.env.DASHSCOPE_BASE_URL?.trim()) throw new Error("DASHSCOPE_BASE_URL is not set in this process.");
}

function enrichError(error: unknown): Error {
  if (!error || typeof error !== "object") return new Error(String(error));
  const value = error as Record<string, unknown>;
  const details = {
    status: value.status,
    code: value.code,
    type: value.type,
    param: value.param,
    requestId: value.request_id,
    apiError: value.error,
  };
  const visible = Object.fromEntries(Object.entries(details).filter(([, item]) => item !== undefined));
  const suffix = Object.keys(visible).length > 0 ? `\nAPI details: ${JSON.stringify(visible)}` : "";
  return new Error(`${errorMessage(error)}${suffix}`, { cause: error });
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

await main();
