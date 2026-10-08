// Local Chroma lifecycle. The npm package supplies both the TypeScript client
// and a native-backed CLI; the CLI must run in a child process because its
// server loop is blocking. Only a loopback port is exposed, and the selected
// URL is inherited by the agent host through ACCOUNTANT24_CHROMA_URL.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { chromaDataDir } from "../env";

export const CHROMA_URL_ENV = "ACCOUNTANT24_CHROMA_URL";
export const CHROMA_HOST = "127.0.0.1";
export const CHROMA_HEARTBEAT_PATH = "/api/v2/heartbeat";
export const CHROMA_READY_ATTEMPTS = 100;
export const CHROMA_READY_INTERVAL_MS = 100;

interface PortProbe {
  once(event: "error", listener: (error: Error) => void): this;
  listen(port: number, host: string, listener: () => void): this;
  address(): string | { port: number } | null;
  close(listener: (error?: Error) => void): this;
  unref(): this;
}

type SpawnChroma = (executable: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;

export interface ChromaServerDependencies {
  allocatePort: () => Promise<number>;
  cliPath: () => string;
  dataDir: () => string;
  delay: (milliseconds: number) => Promise<void>;
  env: NodeJS.ProcessEnv;
  executablePath: string;
  heartbeat: (url: string) => Promise<boolean>;
  readyAttempts: number;
  readyIntervalMs: number;
  spawn: SpawnChroma;
}

export interface ChromaConnection {
  host: string;
  port: number;
  url: string;
}

/** Ask the OS for an unused loopback port, then release it for Chroma. */
export function findAvailablePort(createProbe: () => PortProbe = createServer): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createProbe();
    probe.once("error", reject);
    probe.listen(0, CHROMA_HOST, () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("failed to allocate a local Chroma port")));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
    probe.unref();
  });
}

/** Resolve the CLI shipped by the installed chromadb package without relying
 *  on node_modules/.bin, which electron-builder does not promise to retain. */
export function resolveChromaCliPath(): string {
  const require = createRequire(import.meta.url);
  const packageEntry = require.resolve("chromadb");
  // The require export is dist/cjs/chromadb.cjs; cli.mjs is in dist/.
  return join(dirname(packageEntry), "..", "cli.mjs");
}

export async function checkChromaHeartbeat(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}${CHROMA_HEARTBEAT_PATH}`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const defaults: ChromaServerDependencies = {
  allocatePort: findAvailablePort,
  cliPath: resolveChromaCliPath,
  dataDir: chromaDataDir,
  delay: wait,
  env: process.env,
  executablePath: process.execPath,
  heartbeat: checkChromaHeartbeat,
  readyAttempts: CHROMA_READY_ATTEMPTS,
  readyIntervalMs: CHROMA_READY_INTERVAL_MS,
  spawn,
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class LocalChromaServer {
  private readonly deps: ChromaServerDependencies;
  private process: ChildProcess | null = null;
  private connection: ChromaConnection | null = null;
  private starting: Promise<ChromaConnection> | null = null;
  private generation = 0;
  private stderrTail = "";

  constructor(dependencies: Partial<ChromaServerDependencies> = {}) {
    this.deps = { ...defaults, ...dependencies };
  }

  start(): Promise<ChromaConnection> {
    if (this.connection) return Promise.resolve(this.connection);
    if (this.starting) return this.starting;

    // This variable belongs to the app-managed server. Never leak a stale URL
    // into an agent host if startup fails during this launch.
    delete this.deps.env[CHROMA_URL_ENV];
    const operation = this.startOnce(this.generation);
    this.starting = operation;
    void operation.then(
      () => {
        if (this.starting === operation) this.starting = null;
      },
      () => {
        if (this.starting === operation) this.starting = null;
      },
    );
    return operation;
  }

  stop(): void {
    this.generation++;
    const child = this.process;
    this.process = null;
    this.clearConnection();
    if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }

  private async startOnce(generation: number): Promise<ChromaConnection> {
    const dataDir = this.deps.dataDir();
    mkdirSync(dataDir, { recursive: true });
    const port = await this.deps.allocatePort();
    this.assertCurrentGeneration(generation);
    const connection: ChromaConnection = {
      host: CHROMA_HOST,
      port,
      url: `http://${CHROMA_HOST}:${port}`,
    };
    const args = [
      this.deps.cliPath(),
      "run",
      "--path",
      dataDir,
      "--host",
      connection.host,
      "--port",
      String(connection.port),
    ];
    const child = this.deps.spawn(this.deps.executablePath, args, {
      env: { ...this.deps.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    this.stderrTail = "";

    let processFailure: string | null = null;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const line = chunk.trimEnd();
      if (line) console.log(`[chroma] ${line}`);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4_000);
    });
    child.once("error", (error) => {
      processFailure = errorText(error);
    });
    child.once("exit", (code, signal) => {
      if (this.process !== child) return;
      const wasReady = this.connection !== null;
      processFailure ??= `${wasReady ? "exited unexpectedly" : "exited before becoming ready"} (code=${code}, signal=${signal ?? "none"})`;
      this.process = null;
      this.clearConnection();
      if (wasReady) {
        console.error(`[chroma] local server stopped unexpectedly: ${processFailure}`);
      }
    });

    try {
      for (let attempt = 0; attempt < this.deps.readyAttempts; attempt++) {
        if (processFailure) throw new Error(processFailure);
        const ready = await this.deps.heartbeat(connection.url);
        this.assertCurrentGeneration(generation);
        if (processFailure) throw new Error(processFailure);
        if (ready) {
          this.connection = connection;
          this.deps.env[CHROMA_URL_ENV] = connection.url;
          return connection;
        }
        if (attempt + 1 < this.deps.readyAttempts) {
          await this.deps.delay(this.deps.readyIntervalMs);
        }
      }
      throw new Error(`did not answer heartbeat after ${this.deps.readyAttempts} attempts`);
    } catch (error) {
      if (this.process === child) this.process = null;
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      this.clearConnection();
      const detail = this.stderrTail.trim();
      throw new Error(`Local Chroma failed to start: ${errorText(error)}${detail ? `\n${detail}` : ""}`, {
        cause: error,
      });
    }
  }

  private assertCurrentGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error("startup was cancelled");
  }

  private clearConnection(): void {
    const activeUrl = this.connection?.url;
    this.connection = null;
    if (activeUrl === undefined || this.deps.env[CHROMA_URL_ENV] === activeUrl) {
      delete this.deps.env[CHROMA_URL_ENV];
    }
  }
}

export const localChromaServer = new LocalChromaServer();
