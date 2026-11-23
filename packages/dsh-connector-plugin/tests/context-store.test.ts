import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_CONTEXT_SEPARATOR,
  ConnectorValidationError,
  createConnectorContext,
  createDefaultContextIdGenerator,
  type Connector,
} from "@dsh-connector/core";
import {
  CONNECTOR_CONTEXT_DOMAIN,
  DefaultContextSessionStore,
  parseContextHashKey,
  toContextHashKey,
} from "../src/context-store";
import { TestDshHost } from "./mocks/mock-dsh-host";

const tapdConnector: Connector<"tapd"> = {
  name: "tapd",
  getSender: () => undefined,
  getReceiver: () => undefined,
};
const githubConnector: Connector<"github"> = {
  name: "github",
  getSender: () => undefined,
  getReceiver: () => undefined,
};
const wecomConnector: Connector<"wecom"> = {
  name: "wecom",
  getSender: () => undefined,
  getReceiver: () => undefined,
};

describe("ConnectorContextHashKey codec", () => {
  it("formats and parses ${connector_name}--${context_id} using CONNECTOR_CONTEXT_SEPARATOR", () => {
    const ctx = createConnectorContext(tapdConnector, "2001--story--10086");
    const hashKey = toContextHashKey(ctx);
    expect(hashKey).toBe(`tapd${CONNECTOR_CONTEXT_SEPARATOR}2001--story--10086`);

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
    await expect(store.bind("session-1", ctx42)).resolves.toBeUndefined();

    await expect(store.bind("session-1", ctx43)).rejects.toThrow(ConnectorValidationError);
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

  it("persists pure JSON ConnectorContext records via real @deepseek-ai/dsh-storage-domain and cascades removeSession across restarts", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "dsh-domain-store-"));
    tempDirs.push(storageRoot);

    const host1 = await TestDshHost.start({ storageRoot });
    const domain1 = await host1.ctx.storageDomain.open(CONNECTOR_CONTEXT_DOMAIN);
    const store1 = DefaultContextSessionStore.fromDomain(domain1);

    const tapdCtx = createConnectorContext(tapdConnector, "2001/story/10086");
    const githubCtx = createConnectorContext(githubConnector, "chiichen/dsh-connector#9");

    await store1.bind("session-persist", tapdCtx);
    await store1.bind("session-persist", githubCtx);
    await domain1.close();
    await host1.stop({ keepStorageDir: true });

    // Cold host restart over the same storageRoot
    const host2 = await TestDshHost.start({ storageRoot });
    const domain2 = await host2.ctx.storageDomain.open(CONNECTOR_CONTEXT_DOMAIN);
    const store2 = DefaultContextSessionStore.fromDomain(domain2);

    const recoveredTapd = await store2.getContext("session-persist", "tapd");
    expect(recoveredTapd).toEqual(tapdCtx);
    expect(Object.isFrozen(recoveredTapd)).toBe(true);
    expect(await store2.getSessionId(githubCtx)).toBe("session-persist");

    // Delete session and verify cascade cleanup across another restart
    await store2.removeSession("session-persist");
    expect(await store2.getSessionId(tapdCtx)).toBeUndefined();
    expect(await store2.getContext("session-persist", "tapd")).toBeUndefined();
    await domain2.close();
    await host2.stop({ keepStorageDir: true });

    const host3 = await TestDshHost.start({ storageRoot });
    const domain3 = await host3.ctx.storageDomain.open(CONNECTOR_CONTEXT_DOMAIN);
    const store3 = DefaultContextSessionStore.fromDomain(domain3);
    expect(await store3.getSessionId(tapdCtx)).toBeUndefined();
    await domain3.close();
    await host3.stop({ keepStorageDir: true });
  });
});
