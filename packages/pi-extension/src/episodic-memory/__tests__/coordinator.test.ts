import { describe, expect, it } from "vitest";
import { MemoryCoordinator } from "../coordinator";

describe("MemoryCoordinator", () => {
  it("should run jobs in FIFO order even when the first job is slower", async () => {
    const coordinator = new MemoryCoordinator();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = coordinator.enqueue(async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
    });
    const second = coordinator.enqueue(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second, coordinator.idle()]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("should continue after a rejected job", async () => {
    const coordinator = new MemoryCoordinator();
    await expect(coordinator.enqueue(async () => Promise.reject(new Error("failed")))).rejects.toThrow("failed");
    await expect(coordinator.enqueue(async () => "next")).resolves.toBe("next");
  });
});
