import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHROMA_HEARTBEAT_PATH,
  CHROMA_HOST,
  CHROMA_URL_ENV,
  checkChromaHeartbeat,
  findAvailablePort,
  LocalChromaServer,
  resolveChromaCliPath,
  wait,
} from "../server";

type FakeChild = Omit<ChildProcess, "exitCode" | "killed" | "stderr" | "stdout"> & {
  exitCode: number | null;
  killed: boolean;
  stdout: PassThrough;
  stderr: PassThrough;
};

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    child.killed = true;
    child.emit("exit", null, typeof signal === "string" ? signal : null);
    return true;
  });
  return child;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "a24-chroma-server-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function setup(overrides: Record<string, unknown> = {}) {
  const child = makeChild();
  const env: NodeJS.ProcessEnv = { KEEP_ME: "yes", [CHROMA_URL_ENV]: "http://stale:8000" };
  const heartbeat = vi.fn(async () => true);
  const delay = vi.fn(async () => undefined);
  const spawn = vi.fn(() => child);
  const server = new LocalChromaServer({
    allocatePort: async () => 43123,
    cliPath: () => "/app/node_modules/chromadb/dist/cli.mjs",
    dataDir: () => path.join(root, "rag", "chroma"),
    delay,
    env,
    executablePath: "/Applications/Accountant24/Electron",
    heartbeat,
    readyAttempts: 3,
    readyIntervalMs: 25,
    spawn,
    ...overrides,
  });
  return { child, delay, env, heartbeat, server, spawn };
}

describe("LocalChromaServer", () => {
  it("should start the bundled CLI on a private port and publish its URL after heartbeat", async () => {
    const { child, env, heartbeat, server, spawn } = setup();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const connectionPromise = server.start();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    child.stdout.emit("data", "server output\n");
    await expect(connectionPromise).resolves.toEqual({
      host: CHROMA_HOST,
      port: 43123,
      url: "http://127.0.0.1:43123",
    });

    expect(existsSync(path.join(root, "rag", "chroma"))).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "/Applications/Accountant24/Electron",
      [
        "/app/node_modules/chromadb/dist/cli.mjs",
        "run",
        "--path",
        path.join(root, "rag", "chroma"),
        "--host",
        "127.0.0.1",
        "--port",
        "43123",
      ],
      {
        env: { KEEP_ME: "yes", ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(heartbeat).toHaveBeenCalledWith("http://127.0.0.1:43123");
    expect(env[CHROMA_URL_ENV]).toBe("http://127.0.0.1:43123");
    expect(log).toHaveBeenCalledWith("[chroma] server output");
  });

  it("should share one startup and reuse the ready connection", async () => {
    let releaseHeartbeat: (() => void) | undefined;
    const heartbeat = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseHeartbeat = () => resolve(true);
        }),
    );
    const { server, spawn } = setup({ heartbeat });

    const first = server.start();
    const concurrent = server.start();
    expect(concurrent).toBe(first);
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(1));
    releaseHeartbeat?.();
    const ready = await first;
    await expect(server.start()).resolves.toBe(ready);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("should retry failed heartbeats at the configured interval", async () => {
    const heartbeat = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { delay, server } = setup({ heartbeat });
    await server.start();
    expect(heartbeat).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenNthCalledWith(1, 25);
  });

  it("should kill the child and reject when readiness times out", async () => {
    const { child, env, server } = setup({ heartbeat: vi.fn(async () => false), readyAttempts: 2 });
    await expect(server.start()).rejects.toThrow("did not answer heartbeat after 2 attempts");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(env[CHROMA_URL_ENV]).toBeUndefined();
  });

  it("should surface spawn failures and preserve the stderr tail", async () => {
    const { child, server } = setup({
      heartbeat: vi.fn(async () => {
        child.stderr.write("native binding could not load\n");
        child.emit("error", new Error("spawn EACCES"));
        return false;
      }),
    });
    await expect(server.start()).rejects.toThrow(/spawn EACCES[\s\S]*native binding could not load/);
  });

  it("should surface an exit that happens before readiness", async () => {
    const { child, server } = setup({
      heartbeat: vi.fn(async () => {
        child.emit("exit", 23, null);
        return false;
      }),
    });
    await expect(server.start()).rejects.toThrow("exited before becoming ready (code=23, signal=none)");
  });

  it("should reject when the child exits during a successful heartbeat", async () => {
    const { child, env, server } = setup({
      heartbeat: vi.fn(async () => {
        child.emit("exit", 24, null);
        return true;
      }),
    });
    await expect(server.start()).rejects.toThrow("exited before becoming ready (code=24, signal=none)");
    expect(env[CHROMA_URL_ENV]).toBeUndefined();
  });

  it("should cancel startup when stopped while allocating a port", async () => {
    let releasePort: ((port: number) => void) | undefined;
    const allocatePort = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          releasePort = resolve;
        }),
    );
    const { env, server, spawn } = setup({ allocatePort });
    const starting = server.start();
    await vi.waitFor(() => expect(allocatePort).toHaveBeenCalledTimes(1));
    server.stop();
    releasePort?.(43123);
    await expect(starting).rejects.toThrow("startup was cancelled");
    expect(spawn).not.toHaveBeenCalled();
    expect(env[CHROMA_URL_ENV]).toBeUndefined();
  });

  it("should cancel startup when stopped during a heartbeat", async () => {
    let releaseHeartbeat: ((ready: boolean) => void) | undefined;
    const heartbeat = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseHeartbeat = resolve;
        }),
    );
    const { child, env, server } = setup({ heartbeat });
    const starting = server.start();
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(1));
    server.stop();
    releaseHeartbeat?.(true);
    await expect(starting).rejects.toThrow("startup was cancelled");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(env[CHROMA_URL_ENV]).toBeUndefined();
  });

  it("should stop a running child and remove only its published URL", async () => {
    const { child, env, server } = setup();
    await server.start();
    server.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(env[CHROMA_URL_ENV]).toBeUndefined();
  });

  it("should not signal a child that has already exited", async () => {
    const { child, server } = setup();
    await server.start();
    child.exitCode = 0;
    server.stop();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("should clear the URL and report an unexpected runtime exit", async () => {
    const { child, env, server } = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await server.start();
    child.emit("exit", 9, "SIGKILL");
    expect(env[CHROMA_URL_ENV]).toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      "[chroma] local server stopped unexpectedly: exited unexpectedly (code=9, signal=SIGKILL)",
    );
  });

  it("should not delete an URL that another owner replaced", async () => {
    const { env, server } = setup();
    await server.start();
    env[CHROMA_URL_ENV] = "http://replacement:9000";
    server.stop();
    expect(env[CHROMA_URL_ENV]).toBe("http://replacement:9000");
  });
});

describe("findAvailablePort", () => {
  function probe(options: { address?: string | { port: number } | null; closeError?: Error } = {}) {
    let onError: ((error: Error) => void) | undefined;
    return {
      once: vi.fn((_event: "error", listener: (error: Error) => void) => {
        onError = listener;
        return api;
      }),
      listen: vi.fn((_port: number, _host: string, listener: () => void) => {
        listener();
        return api;
      }),
      address: vi.fn(() => options.address ?? { port: 45678 }),
      close: vi.fn((listener: (error?: Error) => void) => {
        listener(options.closeError);
        return api;
      }),
      unref: vi.fn(() => api),
      fail: (error: Error) => onError?.(error),
    };
    function api() {
      return undefined;
    }
  }

  it("should resolve the ephemeral loopback port selected by the OS", async () => {
    const fake = probe();
    await expect(findAvailablePort(() => fake as never)).resolves.toBe(45678);
    expect(fake.listen).toHaveBeenCalledWith(0, CHROMA_HOST, expect.any(Function));
    expect(fake.unref).toHaveBeenCalledTimes(1);
  });

  it("should reject a non-TCP address", async () => {
    const fake = probe({ address: "/tmp/socket" });
    await expect(findAvailablePort(() => fake as never)).rejects.toThrow("failed to allocate");
  });

  it("should reject when releasing the probe socket fails", async () => {
    const fake = probe({ closeError: new Error("close failed") });
    await expect(findAvailablePort(() => fake as never)).rejects.toThrow("close failed");
  });

  it("should reject when the probe socket emits an error", async () => {
    const fake = probe();
    fake.listen.mockImplementation(() => api);
    const result = findAvailablePort(() => fake as never);
    fake.fail(new Error("listen denied"));
    await expect(result).rejects.toThrow("listen denied");

    function api() {
      return undefined;
    }
  });
});

describe("checkChromaHeartbeat", () => {
  it("should return true only for an OK heartbeat response", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkChromaHeartbeat("http://127.0.0.1:8000")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(`http://127.0.0.1:8000${CHROMA_HEARTBEAT_PATH}`, {
      signal: expect.any(AbortSignal),
    });
  });

  it("should return false for a non-OK response or network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    await expect(checkChromaHeartbeat("http://local")).resolves.toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(checkChromaHeartbeat("http://local")).resolves.toBe(false);
  });
});

describe("resolveChromaCliPath", () => {
  it("should resolve the CLI installed with chromadb", () => {
    expect(resolveChromaCliPath()).toMatch(/chromadb[/\\]dist[/\\]cli\.mjs$/);
    expect(existsSync(resolveChromaCliPath())).toBe(true);
  });
});

describe("wait", () => {
  it("should resolve after the requested delay", async () => {
    vi.useFakeTimers();
    const result = wait(75);
    await vi.advanceTimersByTimeAsync(74);
    let resolved = false;
    void result.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
