/**
 * A minimal counting semaphore. Used to bound the number of in-flight model
 * calls without pulling in a dependency.
 */
export class Semaphore {
  private readonly limit: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("concurrency must be a positive integer");
    }
    this.limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) {
      this.active += 1;
      next();
    }
  }
}
