export class MemoryCoordinator {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}

export const episodicMemoryCoordinator = new MemoryCoordinator();
