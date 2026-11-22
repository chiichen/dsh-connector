import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectorValidationError,
  createConnectorContext,
  createDefaultContextIdGenerator,
  type ConnectorBase,
  type ConnectorContextId,
} from "@dsh-connector/core";
import {
  DefaultContextSessionStore,
  DshStorageDomainAdapter,
  JsonFileContextStorageAdapter,
  parseContextHashKey,
  toContextHashKey,
} from "../src/context-store.js";

const tapdConnector: ConnectorBase = { name: "tapd" };
const githubConnector: ConnectorBase = { name: "github" };
const wecomConnector: ConnectorBase = { name: "wecom" };

describe("ConnectorContextHashKey codec", () => {
  it("formats and parses ${connector_name}--${context_id} losslessly even when contextId contains --", () => {
    const ctx = createConnectorContext(tapdConnector, "2001--story--10086");
    const hashKey = toContextHashKey(ctx);
    expect(hashKey).toBe("tapd--2001--story--10086");

    const parsed = parseContextHashKey(hashKey);
    expect(parsed).toEqual({
      connectorName: "tapd",
      contextId: "2001--story--10086",
    });
  });
});

describe("DefaultContextSessionStore", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("maintains bidirectional mappings for a single session across multiple connectors", async () => {
    const store = new DefaultContextSessionStore();
    const tapdCtx = createConnectorContext(tapdConnector, "story:10086");
    const githubCtx = createConnectorContext(githubConnector, "chiichen/dsh-connector#42");
    const wecomCtx = createConnectorContext(wecomConnector, "chat:ops");

    await store.bind("session-1", tapdCtx);
    await store.bind("session-1", githubCtx);
    await store.bind("session-1", wecomCtx);

    expect(await store.getSessionId(tapdCtx)).toBe("session-1");
    expect(await store.getSessionId(githubCtx)).toBe("session-1");
    expect(await store.getSessionId(wecomCtx)).toBe("session-1");

    expect(await store.getContext("session-1", "tapd")).toEqual(tapdCtx);
    expect(await store.getContext("session-1", "github")).toEqual(githubCtx);
    expect(await store.getContext("session-1", "wecom")).toEqual(wecomCtx);

    const all = await store.getAllContexts("session-1");
    expect(Object.keys(all).sort()).toEqual(["github", "tapd", "wecom"]);
  });

  it("enforces the 1:1 invariant per (sessionId, connectorName) and prevents cross-session hijacking", async () => {
    const store = new DefaultContextSessionStore();
    const ctx42 = createConnectorContext(githubConnector, "org/repo#42");
    const ctx43 = createConnectorContext(githubConnector, "org/repo#43");

    await store.bind("session-1", ctx42);
    // Idempotent re-bind of identical context succeeds
    await expect(store.bind("session-1", ctx42)).resolves.toBeUndefined();

    // Binding a second distinct contextId for the same connector in the same session is rejected
    await expect(store.bind("session-1", ctx43)).rejects.toThrow(ConnectorValidationError);

    // Binding an already-claimed context to a different session is rejected
    await expect(store.bind("session-2", ctx42)).rejects.toThrow(ConnectorValidationError);
  });

  it("coalesces concurrent getOrCreateContext calls into a single generated UUID per (session, connector)", async () => {
    const store = new DefaultContextSessionStore();
    const baseGen = createDefaultContextIdGenerator();
    const generateSpy = vi.spyOn(baseGen, "generate");

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.getOrCreateContext("session-parallel", githubConnector, baseGen),
      ),
    );

    expect(generateSpy).toHaveBeenCalledTimes(1);
    const first = results[0]!;
    for (const item of results) {
      expect(item).toEqual(first);
      expect(Object.isFrozen(item)).toBe(true);
    }
    expect(await store.getSessionId(first)).toBe("session-parallel");
  });

  it("persists pure JSON ConnectorContext records to disk and recovers after restart, plus cascades removeSession", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-ctx-store-"));
    tempDirs.push(dir);
    const filePath = join(dir, "bindings.json");

    const store1 = await DefaultContextSessionStore.open(
      new JsonFileContextStorageAdapter(filePath),
    );
    const tapdCtx = createConnectorContext(tapdConnector, "2001/story/10086");
    const githubCtx = createConnectorContext(githubConnector, "chiichen/dsh-connector#9");

    await store1.bind("session-persist", tapdCtx);
    await store1.bind("session-persist", githubCtx);

    // Simulate process restart
    const store2 = await DefaultContextSessionStore.open(
      new JsonFileContextStorageAdapter(filePath),
    );
    const recoveredTapd = await store2.getContext("session-persist", "tapd");
    expect(recoveredTapd).toEqual(tapdCtx);
    expect(Object.isFrozen(recoveredTapd)).toBe(true);
    expect(await store2.getSessionId(githubCtx)).toBe("session-persist");

    // Delete session and verify cascade cleanup across restart
    await store2.removeSession("session-persist");
    expect(await store2.getSessionId(tapdCtx)).toBeUndefined();
    expect(await store2.getContext("session-persist", "tapd")).toBeUndefined();

    const store3 = await DefaultContextSessionStore.open(
      new JsonFileContextStorageAdapter(filePath),
    );
    expect(await store3.getSessionId(tapdCtx)).toBeUndefined();
  });

  it("supports DshStorageDomainAdapter over a host KV table", async () => {
    const backing = new Map<
      string,
      { sessionId: string; connectorName: string; contextId: ConnectorContextId }
    >();
    const kvTable = {
      async entries() {
        return [...backing.entries()];
      },
      async set(
        key: string,
        value: { sessionId: string; connectorName: string; contextId: ConnectorContextId },
      ) {
        backing.set(key, value);
      },
      async delete(key: string) {
        return backing.delete(key);
      },
    };

    const store1 = await DefaultContextSessionStore.open(new DshStorageDomainAdapter(kvTable));
    const ctx = createConnectorContext(tapdConnector, "story:777");
    await store1.bind("session-kv", ctx);

    const store2 = await DefaultContextSessionStore.open(new DshStorageDomainAdapter(kvTable));
    expect(await store2.getSessionId(ctx)).toBe("session-kv");
    expect(await store2.getContext("session-kv", "tapd")).toEqual(ctx);
  });
});
