import { describe, expect, it } from "vitest";
import { KeyedSerialQueue, TtlDeduplicator } from "../src/reliability";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("KeyedSerialQueue", () => {
  it("serializes tasks sharing the same key in strict FIFO order while running distinct keys in parallel", async () => {
    const queue = new KeyedSerialQueue();
    const events: string[] = [];

    const p1 = queue.run("tapd--100", async () => {
      events.push("a1-start");
      await delay(30);
      events.push("a1-end");
      return 1;
    });

    const p2 = queue.run("tapd--100", async () => {
      events.push("a2-start");
      await delay(5);
      events.push("a2-end");
      return 2;
    });

    const p3 = queue.run("github--42", async () => {
      events.push("b1-start");
      await delay(10);
      events.push("b1-end");
      return 3;
    });

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual([1, 2, 3]);

    expect(events.indexOf("a1-end")).toBeLessThan(events.indexOf("a2-start"));
    expect(events.indexOf("b1-end")).toBeLessThan(events.indexOf("a1-end"));
    expect(queue.activeKeyCount).toBe(0);
  });

  it("isolates task errors without blocking subsequent tasks on the same key", async () => {
    const queue = new KeyedSerialQueue();

    const failing = queue.run("wecom--1", async () => {
      await delay(5);
      throw new Error("boom");
    });

    const succeeding = queue.run("wecom--1", async () => "recovered");

    await expect(failing).rejects.toThrow("boom");
    await expect(succeeding).resolves.toBe("recovered");
    expect(queue.activeKeyCount).toBe(0);
  });
});

describe("TtlDeduplicator", () => {
  it("deduplicates keys within TTL window and expires them after TTL", () => {
    const dedup = new TtlDeduplicator({ ttlMs: 1000, maxEntries: 100 });

    expect(dedup.checkAndRecord("evt-1", 100)).toBe(false);
    expect(dedup.checkAndRecord("evt-1", 500)).toBe(true);
    expect(dedup.checkAndRecord("evt-1", 1101)).toBe(false);
  });

  it("evicts oldest entries when maxEntries capacity is exceeded", () => {
    const dedup = new TtlDeduplicator({ ttlMs: 10_000, maxEntries: 2 });

    expect(dedup.checkAndRecord("k1", 10)).toBe(false);
    expect(dedup.checkAndRecord("k2", 20)).toBe(false);
    expect(dedup.checkAndRecord("k3", 30)).toBe(false);

    expect(dedup.has("k1", 40)).toBe(false);
    expect(dedup.has("k2", 40)).toBe(true);
    expect(dedup.has("k3", 40)).toBe(true);
  });

  it("deletes an active key explicitly before TTL expiration", () => {
    const dedup = new TtlDeduplicator({ ttlMs: 10_000, maxEntries: 10 });

    dedup.record("evt-del", 100);
    expect(dedup.has("evt-del", 200)).toBe(true);
    expect(dedup.delete("evt-del")).toBe(true);
    expect(dedup.has("evt-del", 200)).toBe(false);
    expect(dedup.delete("evt-del")).toBe(false);
  });

  it("uses default options, refreshes existing keys on re-record, and prunes expired keys during record", () => {
    const defaultDedup = new TtlDeduplicator();
    expect(defaultDedup.checkAndRecord("default-k")).toBe(false);
    expect(defaultDedup.has("default-k")).toBe(true);

    const shortTtl = new TtlDeduplicator({ ttlMs: 100, maxEntries: 5 });
    shortTtl.record("stale-1", 10);
    shortTtl.record("stale-2", 20);
    shortTtl.record("refreshed", 30);
    // Re-recording an existing key refreshes its position and expiration
    shortTtl.record("refreshed", 90);

    // At t = 150, stale-1 (exp 110) and stale-2 (exp 120) are pruned during record(), while refreshed (exp 190) survives
    shortTtl.record("fresh-3", 150);
    expect(shortTtl.has("refreshed", 160)).toBe(true);
    expect(shortTtl.has("fresh-3", 160)).toBe(true);
    expect(shortTtl.has("stale-1", 160)).toBe(false);
  });
});
