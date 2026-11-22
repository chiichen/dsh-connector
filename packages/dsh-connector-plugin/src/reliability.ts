export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  get activeKeyCount(): number {
    return this.tails.size;
  }

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const resultPromise = previous.then(operation);
    const tail = resultPromise.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);

    return resultPromise.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
  }
}

export interface TtlDeduplicatorOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

export class TtlDeduplicator {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly seen = new Map<string, number>();

  constructor(options?: TtlDeduplicatorOptions) {
    this.ttlMs = options?.ttlMs ?? 5 * 60 * 1000;
    this.maxEntries = Math.max(1, options?.maxEntries ?? 4096);
  }

  has(key: string, now: number = Date.now()): boolean {
    const expiresAt = this.seen.get(key);
    if (expiresAt === undefined) {
      return false;
    }
    if (now >= expiresAt) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }

  record(key: string, now: number = Date.now()): void {
    this.pruneExpired(now);
    if (this.seen.has(key)) {
      this.seen.delete(key);
    }
    this.seen.set(key, now + this.ttlMs);

    while (this.seen.size > this.maxEntries) {
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey === undefined) break;
      this.seen.delete(oldestKey);
    }
  }

  /**
   * Returns `true` if `key` was already recorded within TTL; otherwise records it and returns `false`.
   */
  checkAndRecord(key: string, now: number = Date.now()): boolean {
    if (this.has(key, now)) {
      return true;
    }
    this.record(key, now);
    return false;
  }

  private pruneExpired(now: number): void {
    for (const [k, expiresAt] of this.seen.entries()) {
      if (now >= expiresAt) {
        this.seen.delete(k);
      } else {
        break;
      }
    }
  }
}
