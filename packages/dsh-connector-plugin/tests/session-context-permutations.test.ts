import { SessionId } from "@deepseek-ai/dsh-session";
import { ToolContextUnavailableError } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import {
  ConnectorValidationError,
  createConnectorContext,
  type ConnectorContextId,
} from "@dsh-connector/core";
import {
  DefaultContextSessionStore,
  toContextHashKey,
  type ContextSessionStore,
} from "../src/context-store";
import { ConnectorManager } from "../src/manager";
import { DshSessionDriver, type SessionDriver } from "../src/session-driver";
import { registerConnectorTools } from "../src/tool-bridge";
import { MockGithubPrConnector, MockWecomBotConnector } from "./mocks/mock-connectors";
import { createTestToolRunContext, TestDshHost } from "./mocks/mock-dsh-host";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEST_REPO = "chiichen/dsh-connector" as const;
const USER_CREATED_SESSION_ID = "session-user-created" as const;
const TEST_CWD = "/tmp/permutation-suite" as const;
const PR_PRIMARY = 42;
const PR_SECONDARY = 43;
const PR_TERTIARY = 44;

interface ExpectedBinding {
  readonly sessionId: string;
  readonly connectorName: "github" | "wecom";
  readonly contextId: string;
}

function formatQuotedReply(encodedMessage: string, replyLine: string): string {
  const quoted = encodedMessage
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${quoted}\n\n${replyLine}`;
}

async function assertExactMappingState(options: {
  readonly store: ContextSessionStore;
  readonly sessionDriver: SessionDriver;
  readonly expectedBindings: readonly ExpectedBinding[];
  readonly unboundSessions?: readonly {
    readonly sessionId: string;
    readonly connectorName: "github" | "wecom";
  }[];
}): Promise<void> {
  const { store, sessionDriver, expectedBindings, unboundSessions = [] } = options;

  const perConnectorSessions = new Map<string, Set<string>>();
  const perConnectorContexts = new Map<string, Set<string>>();

  for (const binding of expectedBindings) {
    expect(binding.sessionId.length).toBeGreaterThan(0);
    expect(binding.contextId.length).toBeGreaterThan(0);
    expect(await sessionDriver.exists(binding.sessionId)).toBe(true);

    let sessionSet = perConnectorSessions.get(binding.connectorName);
    if (sessionSet === undefined) {
      sessionSet = new Set();
      perConnectorSessions.set(binding.connectorName, sessionSet);
    }
    expect(sessionSet.has(binding.sessionId)).toBe(false);
    sessionSet.add(binding.sessionId);

    let contextSet = perConnectorContexts.get(binding.connectorName);
    if (contextSet === undefined) {
      contextSet = new Set();
      perConnectorContexts.set(binding.connectorName, contextSet);
    }
    expect(contextSet.has(binding.contextId)).toBe(false);
    contextSet.add(binding.contextId);

    const expectedCtx = createConnectorContext(binding.connectorName, binding.contextId);
    const forwardCtx = await store.getContext(binding.sessionId, binding.connectorName);
    expect(forwardCtx).toEqual(expectedCtx);
    expect(Object.isFrozen(forwardCtx)).toBe(true);

    const allForSession = await store.getAllContexts(binding.sessionId);
    expect(allForSession[binding.connectorName]).toEqual(expectedCtx);

    expect(await store.getSessionId(expectedCtx)).toBe(binding.sessionId);
    expect(await store.getSessionIdByHashKey(toContextHashKey(expectedCtx))).toBe(
      binding.sessionId,
    );
  }

  for (const unbound of unboundSessions) {
    expect(await sessionDriver.exists(unbound.sessionId)).toBe(true);
    expect(await store.getContext(unbound.sessionId, unbound.connectorName)).toBeUndefined();
  }
}

interface PermutationHarness {
  readonly host: TestDshHost;
  readonly store: DefaultContextSessionStore;
  readonly sessionDriver: DshSessionDriver;
  readonly github: MockGithubPrConnector;
  readonly wecom: MockWecomBotConnector;
  readonly manager: ConnectorManager;
  cleanup(): Promise<void>;
}

async function createPermutationHarness(options?: {
  readonly withUserSession?: boolean;
}): Promise<PermutationHarness> {
  const host = await TestDshHost.start({ useSessionController: true });
  if (options?.withUserSession ?? false) {
    await host.ctx.agents.create({
      sessionId: SessionId(USER_CREATED_SESSION_ID),
      meta: { cwd: TEST_CWD },
    });
  }

  const store = new DefaultContextSessionStore();
  const sessionDriver = new DshSessionDriver(host.ctx, { defaultCwd: TEST_CWD });
  const github = new MockGithubPrConnector();
  const wecom = new MockWecomBotConnector();

  const manager = new ConnectorManager({
    connectors: [github, wecom],
    contextStore: store,
    sessionDriver,
  });
  await manager.startAll();

  return {
    host,
    store,
    sessionDriver,
    github,
    wecom,
    manager,
    async cleanup() {
      await manager.stopAll();
      await host.stop();
    },
  };
}

async function receiveWecomWebhook(
  wecom: MockWecomBotConnector,
  text: string,
  msgId?: string,
): Promise<{ readonly sessionId: string; readonly deduplicated?: boolean }> {
  const receiver = wecom.getReceiver();
  const rawBody = new TextEncoder().encode(
    JSON.stringify(msgId !== undefined ? { text, msgId } : { text }),
  );
  const response = await receiver.handleWebhook!({
    method: "POST",
    pathname: "/webhooks/connectors/wecom",
    subPath: "",
    query: new URLSearchParams(),
    headers: { "content-type": "application/json" },
    rawBody,
  });
  expect(response.status).toBe(202);
  return JSON.parse(String(response.body)) as {
    readonly sessionId: string;
    readonly deduplicated?: boolean;
  };
}

describe("Session <-> ConnectorContextId permutation matrix", () => {
  describe("Initial State 1: Pre-existing user-created session (Send-first sequences)", () => {
    it("[UserSession] Send -> Send -> Send: allocates 1 UUID context on first Send and preserves 1:1 mapping across target PRs", async () => {
      const h = await createPermutationHarness({ withUserSession: true });
      try {
        // Initial: user session exists, unbound
        await assertExactMappingState({
          store: h.store,
          sessionDriver: h.sessionDriver,
          expectedBindings: [],
          unboundSessions: [{ sessionId: USER_CREATED_SESSION_ID, connectorName: "github" }],
        });

        // Step 1: Send (#42)
        await h.manager.dispatchSend("github", USER_CREATED_SESSION_ID, {
          prNumber: PR_PRIMARY,
          body: "Step 1 outbound",
        });
        const allocatedId: ConnectorContextId = h.github.postedComments[0]!.context.contextId;
        expect(allocatedId).toMatch(UUID_V4_PATTERN);
        await assertExactMappingState({
          store: h.store,
          sessionDriver: h.sessionDriver,
          expectedBindings: [
            {
              sessionId: USER_CREATED_SESSION_ID,
              connectorName: "github",
              contextId: allocatedId,
            },
          ],
        });

        // Step 2: Send (#43) -> contextId stays identical
        await h.manager.dispatchSend("github", USER_CREATED_SESSION_ID, {
          prNumber: PR_SECONDARY,
          body: "Step 2 outbound",
        });
        expect(h.github.postedComments[1]!.context.contextId).toBe(allocatedId);

        // Step 3: Send (#44) -> contextId still identical, no extra sessions created
        await h.manager.dispatchSend("github", USER_CREATED_SESSION_ID, {
          prNumber: PR_TERTIARY,
          body: "Step 3 outbound",
        });
        expect(h.github.postedComments[2]!.context.contextId).toBe(allocatedId);
        expect(h.host.persistedSessions.size).toBe(1);

        await assertExactMappingState({
          store: h.store,
          sessionDriver: h.sessionDriver,
          expectedBindings: [
            {
              sessionId: USER_CREATED_SESSION_ID,
              connectorName: "github",
              contextId: allocatedId,
            },
          ],
        });
      } finally {
        await h.cleanup();
      }
    });

    it.each([
      { quoteStepIndex: 0, targetPr: PR_PRIMARY, label: "first Send comment" },
      { quoteStepIndex: 1, targetPr: PR_SECONDARY, label: "second Send comment on another PR" },
    ])(
      "[UserSession] Send -> Send -> onReceive (Reuse user session via Quote of $label)",
      async ({ quoteStepIndex, targetPr }) => {
        const h = await createPermutationHarness({ withUserSession: true });
        try {
          await h.manager.dispatchSend("github", USER_CREATED_SESSION_ID, {
            prNumber: PR_PRIMARY,
            body: "Outbound #1",
          });
          await h.manager.dispatchSend("github", USER_CREATED_SESSION_ID, {
            prNumber: PR_SECONDARY,
            body: "Outbound #2",
          });
          const allocatedId = h.github.postedComments[0]!.context.contextId;

          const inbound = await h.github.simulateWebhookComment({
            repo: TEST_REPO,
            prNumber: targetPr,
            author: "reviewer",
            commentBody: formatQuotedReply(
              h.github.postedComments[quoteStepIndex]!.encodedBody,
              "Reply routed back to user session",
            ),
          });

          expect(inbound.sessionId).toBe(USER_CREATED_SESSION_ID);
          expect(h.host.persistedSessions.size).toBe(1);
          expect(h.host.prompts).toHaveLength(1);
          expect(h.host.prompts[0]!.sessionId).toBe(USER_CREATED_SESSION_ID);

          await assertExactMappingState({
            store: h.store,
            sessionDriver: h.sessionDriver,
            expectedBindings: [
              {
                sessionId: USER_CREATED_SESSION_ID,
                connectorName: "github",
                contextId: allocatedId,
              },
            ],
          });
        } finally {
          await h.cleanup();
        }
      },
    );

    it("[UserSession] Send -> Send -> onReceive (New session on unquoted inbound): creates isolated session without mutating user session", async () => {
      const h = await createPermutationHarness({ withUserSession: true });
      try {
        await h.manager.dispatchSend("github", USER_CREATED_SESSION_ID, {
          prNumber: PR_PRIMARY,
          body: "Outbound #1",
        });
        await h.manager.dispatchSend("github", USER_CREATED_SESSION_ID, {
          prNumber: PR_SECONDARY,
          body: "Outbound #2",
        });
        const userCtxId = h.github.postedComments[0]!.context.contextId;

        // Unquoted top-level comment on PR #42 has natural contextId "chiichen/dsh-connector#42" !== userCtxId
        const inbound = await h.github.simulateWebhookComment({
          repo: TEST_REPO,
          prNumber: PR_PRIMARY,
          author: "external-user",
          commentBody: "Fresh unquoted comment on PR #42",
        });

        expect(inbound.sessionId).not.toBe(USER_CREATED_SESSION_ID);
        expect(h.host.persistedSessions.size).toBe(2);

        await assertExactMappingState({
          store: h.store,
          sessionDriver: h.sessionDriver,
          expectedBindings: [
            {
              sessionId: USER_CREATED_SESSION_ID,
              connectorName: "github",
              contextId: userCtxId,
            },
            {
              sessionId: inbound.sessionId,
              connectorName: "github",
              contextId: `${TEST_REPO}#${PR_PRIMARY}`,
            },
          ],
        });
      } finally {
        await h.cleanup();
      }
    });

    it("[UserSession] Send -> onReceive (Reuse user session) -> Send: keeps identical UUID context across full round-trip", async () => {
      const h = await createPermutationHarness({ withUserSession: true });
      try {
        // Step 1: Send on WeCom (marker-based connector)
        await h.manager.dispatchSend("wecom", USER_CREATED_SESSION_ID, {
          text: "Initial WeCom outbound",
        });
        const userWecomCtxId = h.wecom.sentMessages[0]!.context.contextId;
        expect(userWecomCtxId).toMatch(UUID_V4_PATTERN);

        // Step 2: onReceive Quote -> reuses USER_CREATED_SESSION_ID
        const inbound = await receiveWecomWebhook(
          h.wecom,
          formatQuotedReply(h.wecom.sentMessages[0]!.wireText, "Ack from WeCom"),
        );
        expect(inbound.sessionId).toBe(USER_CREATED_SESSION_ID);
        expect(h.host.persistedSessions.size).toBe(1);

        // Step 3: Send again from USER_CREATED_SESSION_ID -> reuses exact same userWecomCtxId
        await h.manager.dispatchSend("wecom", USER_CREATED_SESSION_ID, {
          text: "Follow-up WeCom outbound",
        });
        expect(h.wecom.sentMessages[1]!.context.contextId).toBe(userWecomCtxId);

        await assertExactMappingState({
          store: h.store,
          sessionDriver: h.sessionDriver,
          expectedBindings: [
            {
              sessionId: USER_CREATED_SESSION_ID,
              connectorName: "wecom",
              contextId: userWecomCtxId,
            },
          ],
        });
      } finally {
        await h.cleanup();
      }
    });

    it.each([
      { thirdStepTarget: "user-session" as const },
      { thirdStepTarget: "new-inbound-session" as const },
    ])(
      "[UserSession] Send -> onReceive (New session) -> Send (on $thirdStepTarget): isolates both sessions' contextIds",
      async ({ thirdStepTarget }) => {
        const h = await createPermutationHarness({ withUserSession: true });
        try {
          // Step 1: Send from user session
          await h.manager.dispatchSend("github", USER_CREATED_SESSION_ID, {
            prNumber: PR_PRIMARY,
            body: "User session comment",
          });
          const userCtxId = h.github.postedComments[0]!.context.contextId;

          // Step 2: Unquoted inbound on PR #43 -> creates a separate session S_new
          const inbound = await h.github.simulateWebhookComment({
            repo: TEST_REPO,
            prNumber: PR_SECONDARY,
            author: "bob",
            commentBody: "Separate PR #43 review",
          });
          expect(inbound.sessionId).not.toBe(USER_CREATED_SESSION_ID);
          const inboundCtxId = `${TEST_REPO}#${PR_SECONDARY}`;

          // Step 3: Send on either session
          if (thirdStepTarget === "user-session") {
            await h.manager.dispatchSend("github", USER_CREATED_SESSION_ID, {
              prNumber: PR_PRIMARY,
              body: "Second send from user session",
            });
            expect(h.github.postedComments[1]!.context.contextId).toBe(userCtxId);
          } else {
            // Inbound session has business contextId "chiichen/dsh-connector#43", so prNumber can be omitted
            await h.manager.dispatchSend("github", inbound.sessionId, {
              body: "Reply from new inbound session",
            });
            expect(h.github.postedComments[1]!.context.contextId).toBe(inboundCtxId);
            expect(h.github.postedComments[1]!.prNumber).toBe(PR_SECONDARY);
          }

          await assertExactMappingState({
            store: h.store,
            sessionDriver: h.sessionDriver,
            expectedBindings: [
              {
                sessionId: USER_CREATED_SESSION_ID,
                connectorName: "github",
                contextId: userCtxId,
              },
              {
                sessionId: inbound.sessionId,
                connectorName: "github",
                contextId: inboundCtxId,
              },
            ],
          });
        } finally {
          await h.cleanup();
        }
      },
    );

    it.each([
      {
        name: "Reuse S_user -> Reuse S_user",
        step2Mode: "reuse-user" as const,
        step3Mode: "reuse-user" as const,
        expectedSessionCount: 1,
      },
      {
        name: "Reuse S_user -> New S_2",
        step2Mode: "reuse-user" as const,
        step3Mode: "new-pr43" as const,
        expectedSessionCount: 2,
      },
      {
        name: "New S_2 -> Reuse S_user (interleaved back to user session)",
        step2Mode: "new-pr43" as const,
        step3Mode: "reuse-user" as const,
        expectedSessionCount: 2,
      },
      {
        name: "New S_2 -> Reuse S_2",
        step2Mode: "new-pr43" as const,
        step3Mode: "reuse-s2" as const,
        expectedSessionCount: 2,
      },
      {
        name: "New S_2 -> New S_3",
        step2Mode: "new-pr43" as const,
        step3Mode: "new-pr44" as const,
        expectedSessionCount: 3,
      },
    ])(
      "[UserSession] Send -> onReceive -> onReceive ($name)",
      async ({ step2Mode, step3Mode, expectedSessionCount }) => {
        const h = await createPermutationHarness({ withUserSession: true });
        try {
          // Step 1: Send on S_user
          await h.manager.dispatchSend("github", USER_CREATED_SESSION_ID, {
            prNumber: PR_PRIMARY,
            body: "Seed outbound on S_user",
          });
          const userCtxId = h.github.postedComments[0]!.context.contextId;
          const quotedUserBody = formatQuotedReply(
            h.github.postedComments[0]!.encodedBody,
            "Quote back to S_user",
          );

          const expectedBindings: ExpectedBinding[] = [
            {
              sessionId: USER_CREATED_SESSION_ID,
              connectorName: "github",
              contextId: userCtxId,
            },
          ];

          // Step 2: onReceive
          let session2Id: string | undefined;
          if (step2Mode === "reuse-user") {
            const r2 = await h.github.simulateWebhookComment({
              repo: TEST_REPO,
              prNumber: PR_PRIMARY,
              author: "u1",
              commentBody: quotedUserBody,
            });
            expect(r2.sessionId).toBe(USER_CREATED_SESSION_ID);
          } else {
            const r2 = await h.github.simulateWebhookComment({
              repo: TEST_REPO,
              prNumber: PR_SECONDARY,
              author: "u1",
              commentBody: "Unquoted PR #43",
            });
            expect(r2.sessionId).not.toBe(USER_CREATED_SESSION_ID);
            session2Id = r2.sessionId;
            expectedBindings.push({
              sessionId: session2Id,
              connectorName: "github",
              contextId: `${TEST_REPO}#${PR_SECONDARY}`,
            });
          }

          // Step 3: onReceive
          if (step3Mode === "reuse-user") {
            const r3 = await h.github.simulateWebhookComment({
              repo: TEST_REPO,
              prNumber: PR_PRIMARY,
              author: "u2",
              commentBody: quotedUserBody,
            });
            expect(r3.sessionId).toBe(USER_CREATED_SESSION_ID);
          } else if (step3Mode === "reuse-s2") {
            const r3 = await h.github.simulateWebhookComment({
              repo: TEST_REPO,
              prNumber: PR_SECONDARY,
              author: "u2",
              commentBody: "Follow-up on PR #43",
            });
            expect(r3.sessionId).toBe(session2Id);
          } else if (step3Mode === "new-pr43") {
            const r3 = await h.github.simulateWebhookComment({
              repo: TEST_REPO,
              prNumber: PR_SECONDARY,
              author: "u2",
              commentBody: "Unquoted PR #43 at step 3",
            });
            expect(r3.sessionId).not.toBe(USER_CREATED_SESSION_ID);
            expectedBindings.push({
              sessionId: r3.sessionId,
              connectorName: "github",
              contextId: `${TEST_REPO}#${PR_SECONDARY}`,
            });
          } else {
            const r3 = await h.github.simulateWebhookComment({
              repo: TEST_REPO,
              prNumber: PR_TERTIARY,
              author: "u2",
              commentBody: "Unquoted PR #44 at step 3",
            });
            expect(r3.sessionId).not.toBe(USER_CREATED_SESSION_ID);
            expect(r3.sessionId).not.toBe(session2Id);
            expectedBindings.push({
              sessionId: r3.sessionId,
              connectorName: "github",
              contextId: `${TEST_REPO}#${PR_TERTIARY}`,
            });
          }

          expect(h.host.persistedSessions.size).toBe(expectedSessionCount);
          await assertExactMappingState({
            store: h.store,
            sessionDriver: h.sessionDriver,
            expectedBindings,
          });
        } finally {
          await h.cleanup();
        }
      },
    );
  });

  describe("Initial State 1B: Pre-existing user session coexisting with onReceive-first sequences", () => {
    it("[UserSession Coexisting] onReceive -> Send(S_user) -> Send(S_in): never hijacks unbound S_user and keeps both sessions disjoint", async () => {
      const h = await createPermutationHarness({ withUserSession: true });
      try {
        // Step 1: External onReceive arrives while S_user is sitting idle and unbound
        const r1 = await h.github.simulateWebhookComment({
          repo: TEST_REPO,
          prNumber: PR_PRIMARY,
          author: "alice",
          commentBody: "Inbound PR #42 while user session exists",
        });
        expect(r1.sessionId).not.toBe(USER_CREATED_SESSION_ID);
        await assertExactMappingState({
          store: h.store,
          sessionDriver: h.sessionDriver,
          expectedBindings: [
            {
              sessionId: r1.sessionId,
              connectorName: "github",
              contextId: `${TEST_REPO}#${PR_PRIMARY}`,
            },
          ],
          unboundSessions: [{ sessionId: USER_CREATED_SESSION_ID, connectorName: "github" }],
        });

        // Step 2: User session performs its first Send -> gets its own UUID context
        await h.manager.dispatchSend("github", USER_CREATED_SESSION_ID, {
          prNumber: PR_SECONDARY,
          body: "User session outbound",
        });
        const userCtxId = h.github.postedComments[0]!.context.contextId;
        expect(userCtxId).toMatch(UUID_V4_PATTERN);

        // Step 3: Inbound session performs Send -> uses its PR #42 context
        await h.manager.dispatchSend("github", r1.sessionId, {
          body: "Inbound session outbound",
        });
        expect(h.github.postedComments[1]!.context.contextId).toBe(`${TEST_REPO}#${PR_PRIMARY}`);

        await assertExactMappingState({
          store: h.store,
          sessionDriver: h.sessionDriver,
          expectedBindings: [
            {
              sessionId: r1.sessionId,
              connectorName: "github",
              contextId: `${TEST_REPO}#${PR_PRIMARY}`,
            },
            {
              sessionId: USER_CREATED_SESSION_ID,
              connectorName: "github",
              contextId: userCtxId,
            },
          ],
        });
      } finally {
        await h.cleanup();
      }
    });

    it("[UserSession Coexisting] onReceive -> Send(S_user) -> onReceive (Quote to S_user vs Reuse S_in)", async () => {
      const h = await createPermutationHarness({ withUserSession: true });
      try {
        // Step 1: Inbound creates S_in
        const sIn = await h.github.simulateWebhookComment({
          repo: TEST_REPO,
          prNumber: PR_PRIMARY,
          author: "alice",
          commentBody: "Inbound #1",
        });

        // Step 2: S_user sends to PR #42 -> gets UUID context
        await h.manager.dispatchSend("github", USER_CREATED_SESSION_ID, {
          prNumber: PR_PRIMARY,
          body: "User session comment on same PR #42",
        });
        const userCtxId = h.github.postedComments[0]!.context.contextId;

        // Step 3: Quote reply to S_user's comment on PR #42 routes to S_user (NOT S_in!)
        const quoteToUser = await h.github.simulateWebhookComment({
          repo: TEST_REPO,
          prNumber: PR_PRIMARY,
          author: "bob",
          commentBody: formatQuotedReply(
            h.github.postedComments[0]!.encodedBody,
            "Replying specifically to user session comment",
          ),
        });
        expect(quoteToUser.sessionId).toBe(USER_CREATED_SESSION_ID);

        await assertExactMappingState({
          store: h.store,
          sessionDriver: h.sessionDriver,
          expectedBindings: [
            {
              sessionId: sIn.sessionId,
              connectorName: "github",
              contextId: `${TEST_REPO}#${PR_PRIMARY}`,
            },
            {
              sessionId: USER_CREATED_SESSION_ID,
              connectorName: "github",
              contextId: userCtxId,
            },
          ],
        });
      } finally {
        await h.cleanup();
      }
    });

    it("[UserSession Coexisting] onReceive -> onReceive (Reuse S_in) -> Send(S_user)", async () => {
      const h = await createPermutationHarness({ withUserSession: true });
      try {
        const r1 = await h.github.simulateWebhookComment({
          repo: TEST_REPO,
          prNumber: PR_PRIMARY,
          author: "alice",
          commentBody: "R1",
        });
        const r2 = await h.github.simulateWebhookComment({
          repo: TEST_REPO,
          prNumber: PR_PRIMARY,
          author: "bob",
          commentBody: "R2 reuse",
        });
        expect(r2.sessionId).toBe(r1.sessionId);

        // S_user remained completely untouched across R1 -> R2
        await assertExactMappingState({
          store: h.store,
          sessionDriver: h.sessionDriver,
          expectedBindings: [
            {
              sessionId: r1.sessionId,
              connectorName: "github",
              contextId: `${TEST_REPO}#${PR_PRIMARY}`,
            },
          ],
          unboundSessions: [{ sessionId: USER_CREATED_SESSION_ID, connectorName: "github" }],
        });

        // Step 3: Send on S_user
        await h.manager.dispatchSend("github", USER_CREATED_SESSION_ID, {
          prNumber: PR_TERTIARY,
          body: "S_user send after R1->R2",
        });
        const userCtxId = h.github.postedComments[0]!.context.contextId;

        await assertExactMappingState({
          store: h.store,
          sessionDriver: h.sessionDriver,
          expectedBindings: [
            {
              sessionId: r1.sessionId,
              connectorName: "github",
              contextId: `${TEST_REPO}#${PR_PRIMARY}`,
            },
            {
              sessionId: USER_CREATED_SESSION_ID,
              connectorName: "github",
              contextId: userCtxId,
            },
          ],
        });
      } finally {
        await h.cleanup();
      }
    });

    it("[UserSession Coexisting] onReceive -> onReceive (Reuse S_in1) -> onReceive (New S_in2): keeps idle S_user completely unbound", async () => {
      const h = await createPermutationHarness({ withUserSession: true });
      try {
        const r1 = await h.github.simulateWebhookComment({
          repo: TEST_REPO,
          prNumber: PR_PRIMARY,
          author: "alice",
          commentBody: "R1 #42",
        });
        const r2 = await h.github.simulateWebhookComment({
          repo: TEST_REPO,
          prNumber: PR_PRIMARY,
          author: "bob",
          commentBody: "R2 #42 reuse",
        });
        const r3 = await h.github.simulateWebhookComment({
          repo: TEST_REPO,
          prNumber: PR_SECONDARY,
          author: "charlie",
          commentBody: "R3 #43 new",
        });

        expect(r2.sessionId).toBe(r1.sessionId);
        expect(r3.sessionId).not.toBe(r1.sessionId);
        expect(r1.sessionId).not.toBe(USER_CREATED_SESSION_ID);
        expect(r3.sessionId).not.toBe(USER_CREATED_SESSION_ID);
        expect(h.host.persistedSessions.size).toBe(3);

        await assertExactMappingState({
          store: h.store,
          sessionDriver: h.sessionDriver,
          expectedBindings: [
            {
              sessionId: r1.sessionId,
              connectorName: "github",
              contextId: `${TEST_REPO}#${PR_PRIMARY}`,
            },
            {
              sessionId: r3.sessionId,
              connectorName: "github",
              contextId: `${TEST_REPO}#${PR_SECONDARY}`,
            },
          ],
          unboundSessions: [{ sessionId: USER_CREATED_SESSION_ID, connectorName: "github" }],
        });
      } finally {
        await h.cleanup();
      }
    });
  });

  describe("Initial State 2: No pre-existing session (Empty initial state)", () => {
    it("[NoSession] Guard: attempting Send without an active session rejects without allocating any context", async () => {
      const h = await createPermutationHarness({ withUserSession: false });
      const disposeTools = registerConnectorTools(h.host.ctx.tools, h.manager);
      try {
        const ghTool = h.host.ctx.tools.get("connector_send_github")!;
        await expect(
          ghTool.execute({ prNumber: PR_PRIMARY, body: "No session" }, createTestToolRunContext()),
        ).rejects.toBeInstanceOf(ToolContextUnavailableError);

        await expect(
          h.manager.dispatchSend("github", "   ", { prNumber: PR_PRIMARY, body: "Blank session" }),
        ).rejects.toThrow(ConnectorValidationError);

        expect(h.host.persistedSessions.size).toBe(0);
        expect(h.github.postedComments).toHaveLength(0);
      } finally {
        disposeTools();
        await h.cleanup();
      }
    });

    it("[NoSession / BusinessID] onReceive (New S_1) -> Send -> Send: mints S_1 on inbound and reuses business contextId across all Sends", async () => {
      const h = await createPermutationHarness({ withUserSession: false });
      try {
        // Step 1: onReceive creates S_1 bound to "chiichen/dsh-connector#42"
        const r1 = await h.github.simulateWebhookComment({
          repo: TEST_REPO,
          prNumber: PR_PRIMARY,
          author: "alice",
          commentBody: "Open PR #42",
        });
        const businessCtxId = `${TEST_REPO}#${PR_PRIMARY}`;
        await assertExactMappingState({
          store: h.store,
          sessionDriver: h.sessionDriver,
          expectedBindings: [
            { sessionId: r1.sessionId, connectorName: "github", contextId: businessCtxId },
          ],
        });

        // Step 2: Send with implicit target -> resolves #42 from businessCtxId
        await h.manager.dispatchSend("github", r1.sessionId, {
          body: "Reply 1 to #42",
        });
        expect(h.github.postedComments[0]!.context.contextId).toBe(businessCtxId);
        expect(h.github.postedComments[0]!.prNumber).toBe(PR_PRIMARY);

        // Step 3: Send cross-posting to #43 -> still preserves S_1 <-> businessCtxId
        await h.manager.dispatchSend("github", r1.sessionId, {
          prNumber: PR_SECONDARY,
          body: "Cross-post to #43",
        });
        expect(h.github.postedComments[1]!.context.contextId).toBe(businessCtxId);
        expect(h.github.postedComments[1]!.prNumber).toBe(PR_SECONDARY);
        expect(h.host.persistedSessions.size).toBe(1);

        await assertExactMappingState({
          store: h.store,
          sessionDriver: h.sessionDriver,
          expectedBindings: [
            { sessionId: r1.sessionId, connectorName: "github", contextId: businessCtxId },
          ],
        });
      } finally {
        await h.cleanup();
      }
    });

    it("[NoSession / StatelessUUID] onReceive (New S_1) -> Send -> Send: allocates UUID on inbound and reuses it across subsequent Sends", async () => {
      const h = await createPermutationHarness({ withUserSession: false });
      try {
        // Step 1: WeCom inbound without marker allocates UUID ctx_w1 and creates S_1
        const r1 = await receiveWecomWebhook(h.wecom, "Hello bot from WeCom");
        const boundCtx = await h.store.getContext(r1.sessionId, "wecom");
        expect(boundCtx?.contextId).toMatch(UUID_V4_PATTERN);
        const allocatedUuid = boundCtx!.contextId;

        // Step 2 & Step 3: Both Sends reuse allocatedUuid
        await h.manager.dispatchSend("wecom", r1.sessionId, { text: "Reply #1" });
        await h.manager.dispatchSend("wecom", r1.sessionId, { text: "Reply #2" });

        expect(h.wecom.sentMessages[0]!.context.contextId).toBe(allocatedUuid);
        expect(h.wecom.sentMessages[1]!.context.contextId).toBe(allocatedUuid);
        expect(h.host.persistedSessions.size).toBe(1);

        await assertExactMappingState({
          store: h.store,
          sessionDriver: h.sessionDriver,
          expectedBindings: [
            { sessionId: r1.sessionId, connectorName: "wecom", contextId: allocatedUuid },
          ],
        });
      } finally {
        await h.cleanup();
      }
    });

    it.each([
      {
        mode: "reuse-same-pr" as const,
        label: "Reuse S_1 via plain follow-up on same PR #42",
      },
      {
        mode: "reuse-cross-pr-quote" as const,
        label: "Reuse S_1 via Quote reply on cross-posted PR #43",
      },
      {
        mode: "new-distinct-pr" as const,
        label: "New S_2 via unquoted comment on PR #44",
      },
    ])("[NoSession / BusinessID] onReceive -> Send -> onReceive ($label)", async ({ mode }) => {
      const h = await createPermutationHarness({ withUserSession: false });
      try {
        // Step 1: onReceive creates S_1 on PR #42
        const r1 = await h.github.simulateWebhookComment({
          repo: TEST_REPO,
          prNumber: PR_PRIMARY,
          author: "alice",
          commentBody: "Initial PR #42",
        });
        const ctx1 = `${TEST_REPO}#${PR_PRIMARY}`;

        // Step 2: Send from S_1 (to PR #43 when testing cross-PR quote, otherwise implicit PR #42)
        await h.manager.dispatchSend(
          "github",
          r1.sessionId,
          mode === "reuse-cross-pr-quote"
            ? { prNumber: PR_SECONDARY, body: "Cross-referenced from #42" }
            : { body: "Reply on #42" },
        );
        expect(h.github.postedComments[0]!.context.contextId).toBe(ctx1);

        // Step 3: onReceive
        if (mode === "reuse-same-pr") {
          const r3 = await h.github.simulateWebhookComment({
            repo: TEST_REPO,
            prNumber: PR_PRIMARY,
            author: "bob",
            commentBody: "Follow-up on #42",
          });
          expect(r3.sessionId).toBe(r1.sessionId);
          expect(h.host.persistedSessions.size).toBe(1);
          await assertExactMappingState({
            store: h.store,
            sessionDriver: h.sessionDriver,
            expectedBindings: [
              { sessionId: r1.sessionId, connectorName: "github", contextId: ctx1 },
            ],
          });
        } else if (mode === "reuse-cross-pr-quote") {
          const r3 = await h.github.simulateWebhookComment({
            repo: TEST_REPO,
            prNumber: PR_SECONDARY,
            author: "bob",
            commentBody: formatQuotedReply(
              h.github.postedComments[0]!.encodedBody,
              "Replying on #43 to cross-reference",
            ),
          });
          expect(r3.sessionId).toBe(r1.sessionId);
          expect(h.host.persistedSessions.size).toBe(1);
          await assertExactMappingState({
            store: h.store,
            sessionDriver: h.sessionDriver,
            expectedBindings: [
              { sessionId: r1.sessionId, connectorName: "github", contextId: ctx1 },
            ],
          });
        } else {
          const r3 = await h.github.simulateWebhookComment({
            repo: TEST_REPO,
            prNumber: PR_TERTIARY,
            author: "charlie",
            commentBody: "Unrelated PR #44",
          });
          expect(r3.sessionId).not.toBe(r1.sessionId);
          expect(h.host.persistedSessions.size).toBe(2);
          await assertExactMappingState({
            store: h.store,
            sessionDriver: h.sessionDriver,
            expectedBindings: [
              { sessionId: r1.sessionId, connectorName: "github", contextId: ctx1 },
              {
                sessionId: r3.sessionId,
                connectorName: "github",
                contextId: `${TEST_REPO}#${PR_TERTIARY}`,
              },
            ],
          });
        }
      } finally {
        await h.cleanup();
      }
    });

    it.each([
      { thirdStepQuotesMarker: true, label: "Reuse S_1 via Quote marker" },
      { thirdStepQuotesMarker: false, label: "New S_2 when unquoted" },
    ])(
      "[NoSession / StatelessUUID] onReceive -> Send -> onReceive ($label)",
      async ({ thirdStepQuotesMarker }) => {
        const h = await createPermutationHarness({ withUserSession: false });
        try {
          const r1 = await receiveWecomWebhook(h.wecom, "First WeCom question");
          await h.manager.dispatchSend("wecom", r1.sessionId, { text: "Bot answer" });
          const ctx1Id = h.wecom.sentMessages[0]!.context.contextId;

          const r3 = await receiveWecomWebhook(
            h.wecom,
            thirdStepQuotesMarker
              ? formatQuotedReply(h.wecom.sentMessages[0]!.wireText, "Quoted follow-up")
              : "Brand new unquoted topic",
          );

          if (thirdStepQuotesMarker) {
            expect(r3.sessionId).toBe(r1.sessionId);
            expect(h.host.persistedSessions.size).toBe(1);
            await assertExactMappingState({
              store: h.store,
              sessionDriver: h.sessionDriver,
              expectedBindings: [
                { sessionId: r1.sessionId, connectorName: "wecom", contextId: ctx1Id },
              ],
            });
          } else {
            expect(r3.sessionId).not.toBe(r1.sessionId);
            expect(h.host.persistedSessions.size).toBe(2);
            const ctx2 = await h.store.getContext(r3.sessionId, "wecom");
            expect(ctx2?.contextId).toMatch(UUID_V4_PATTERN);
            expect(ctx2?.contextId).not.toBe(ctx1Id);
            await assertExactMappingState({
              store: h.store,
              sessionDriver: h.sessionDriver,
              expectedBindings: [
                { sessionId: r1.sessionId, connectorName: "wecom", contextId: ctx1Id },
                { sessionId: r3.sessionId, connectorName: "wecom", contextId: ctx2!.contextId },
              ],
            });
          }
        } finally {
          await h.cleanup();
        }
      },
    );

    it.each([
      {
        mode: "reuse-then-send-s1" as const,
        label: "Reuse S_1 -> Send(S_1)",
      },
      {
        mode: "new-s2-then-send-s1" as const,
        label: "New S_2 -> Send(S_1)",
      },
      {
        mode: "new-s2-then-send-s2" as const,
        label: "New S_2 -> Send(S_2)",
      },
    ])("[NoSession] onReceive -> onReceive -> Send ($label)", async ({ mode }) => {
      const h = await createPermutationHarness({ withUserSession: false });
      try {
        const r1 = await h.github.simulateWebhookComment({
          repo: TEST_REPO,
          prNumber: PR_PRIMARY,
          author: "alice",
          commentBody: "Step 1 on #42",
        });
        const ctx1 = `${TEST_REPO}#${PR_PRIMARY}`;

        if (mode === "reuse-then-send-s1") {
          const r2 = await h.github.simulateWebhookComment({
            repo: TEST_REPO,
            prNumber: PR_PRIMARY,
            author: "bob",
            commentBody: "Step 2 reuse on #42",
          });
          expect(r2.sessionId).toBe(r1.sessionId);

          await h.manager.dispatchSend("github", r1.sessionId, { body: "Step 3 reply on #42" });
          expect(h.github.postedComments[0]!.context.contextId).toBe(ctx1);
          expect(h.github.postedComments[0]!.prNumber).toBe(PR_PRIMARY);
          expect(h.host.persistedSessions.size).toBe(1);

          await assertExactMappingState({
            store: h.store,
            sessionDriver: h.sessionDriver,
            expectedBindings: [
              { sessionId: r1.sessionId, connectorName: "github", contextId: ctx1 },
            ],
          });
        } else {
          const r2 = await h.github.simulateWebhookComment({
            repo: TEST_REPO,
            prNumber: PR_SECONDARY,
            author: "bob",
            commentBody: "Step 2 new session on #43",
          });
          expect(r2.sessionId).not.toBe(r1.sessionId);
          const ctx2 = `${TEST_REPO}#${PR_SECONDARY}`;

          const sendSessionId = mode === "new-s2-then-send-s1" ? r1.sessionId : r2.sessionId;
          const expectedPr = mode === "new-s2-then-send-s1" ? PR_PRIMARY : PR_SECONDARY;
          const expectedSendCtx = mode === "new-s2-then-send-s1" ? ctx1 : ctx2;

          await h.manager.dispatchSend("github", sendSessionId, {
            body: "Step 3 implicit reply",
          });
          expect(h.github.postedComments[0]!.context.contextId).toBe(expectedSendCtx);
          expect(h.github.postedComments[0]!.prNumber).toBe(expectedPr);
          expect(h.host.persistedSessions.size).toBe(2);

          await assertExactMappingState({
            store: h.store,
            sessionDriver: h.sessionDriver,
            expectedBindings: [
              { sessionId: r1.sessionId, connectorName: "github", contextId: ctx1 },
              { sessionId: r2.sessionId, connectorName: "github", contextId: ctx2 },
            ],
          });
        }
      } finally {
        await h.cleanup();
      }
    });

    it.each([
      {
        topology: "[A, A, A] (New S_1 -> Reuse S_1 -> Reuse S_1)",
        prs: [PR_PRIMARY, PR_PRIMARY, PR_PRIMARY] as const,
        expectedPattern: [0, 0, 0] as const,
        uniqueCount: 1,
      },
      {
        topology: "[A, A, B] (New S_1 -> Reuse S_1 -> New S_2)",
        prs: [PR_PRIMARY, PR_PRIMARY, PR_SECONDARY] as const,
        expectedPattern: [0, 0, 1] as const,
        uniqueCount: 2,
      },
      {
        topology: "[A, B, A] (New S_1 -> New S_2 -> Reuse S_1)",
        prs: [PR_PRIMARY, PR_SECONDARY, PR_PRIMARY] as const,
        expectedPattern: [0, 1, 0] as const,
        uniqueCount: 2,
      },
      {
        topology: "[A, B, B] (New S_1 -> New S_2 -> Reuse S_2)",
        prs: [PR_PRIMARY, PR_SECONDARY, PR_SECONDARY] as const,
        expectedPattern: [0, 1, 1] as const,
        uniqueCount: 2,
      },
      {
        topology: "[A, B, C] (New S_1 -> New S_2 -> New S_3)",
        prs: [PR_PRIMARY, PR_SECONDARY, PR_TERTIARY] as const,
        expectedPattern: [0, 1, 2] as const,
        uniqueCount: 3,
      },
    ])(
      "[NoSession] onReceive -> onReceive -> onReceive ($topology)",
      async ({ prs, expectedPattern, uniqueCount }) => {
        const h = await createPermutationHarness({ withUserSession: false });
        try {
          const mintedBySlot = new Map<number, { sessionId: string; prNumber: number }>();

          for (let step = 0; step < 3; step += 1) {
            const prNumber = prs[step]!;
            const slot = expectedPattern[step]!;
            const res = await h.github.simulateWebhookComment({
              repo: TEST_REPO,
              prNumber,
              author: `user-${step}`,
              commentBody: `Comment at step ${step}`,
            });

            const existingSlot = mintedBySlot.get(slot);
            if (existingSlot !== undefined) {
              expect(res.sessionId).toBe(existingSlot.sessionId);
            } else {
              for (const other of mintedBySlot.values()) {
                expect(res.sessionId).not.toBe(other.sessionId);
              }
              mintedBySlot.set(slot, { sessionId: res.sessionId, prNumber });
            }
          }

          expect(mintedBySlot.size).toBe(uniqueCount);
          expect(h.host.persistedSessions.size).toBe(uniqueCount);
          expect(h.host.prompts).toHaveLength(3);

          const expectedBindings: ExpectedBinding[] = Array.from(mintedBySlot.values()).map(
            ({ sessionId, prNumber }) => ({
              sessionId,
              connectorName: "github",
              contextId: `${TEST_REPO}#${prNumber}`,
            }),
          );

          await assertExactMappingState({
            store: h.store,
            sessionDriver: h.sessionDriver,
            expectedBindings,
          });
        } finally {
          await h.cleanup();
        }
      },
    );
  });

  describe("Cross-cutting mapping invariants: multi-connector fan-in & deleted-session self-heal", () => {
    it("converges Send -> onReceive across multiple connectors onto the same user session with independent contextIds", async () => {
      const h = await createPermutationHarness({ withUserSession: true });
      try {
        await h.manager.dispatchSend("github", USER_CREATED_SESSION_ID, {
          prNumber: PR_PRIMARY,
          body: "GitHub outbound",
        });
        await h.manager.dispatchSend("wecom", USER_CREATED_SESSION_ID, {
          text: "WeCom outbound",
        });

        const ghCtxId = h.github.postedComments[0]!.context.contextId;
        const wecomCtxId = h.wecom.sentMessages[0]!.context.contextId;
        expect(ghCtxId).not.toBe(wecomCtxId);

        const ghQuote = await h.github.simulateWebhookComment({
          repo: TEST_REPO,
          prNumber: PR_PRIMARY,
          author: "alice",
          commentBody: formatQuotedReply(h.github.postedComments[0]!.encodedBody, "GitHub reply"),
        });
        const wecomQuote = await receiveWecomWebhook(
          h.wecom,
          formatQuotedReply(h.wecom.sentMessages[0]!.wireText, "WeCom reply"),
        );

        expect(ghQuote.sessionId).toBe(USER_CREATED_SESSION_ID);
        expect(wecomQuote.sessionId).toBe(USER_CREATED_SESSION_ID);
        expect(h.host.persistedSessions.size).toBe(1);

        await assertExactMappingState({
          store: h.store,
          sessionDriver: h.sessionDriver,
          expectedBindings: [
            { sessionId: USER_CREATED_SESSION_ID, connectorName: "github", contextId: ghCtxId },
            { sessionId: USER_CREATED_SESSION_ID, connectorName: "wecom", contextId: wecomCtxId },
          ],
        });
      } finally {
        await h.cleanup();
      }
    });

    it("self-heals Send(S_user) -> [delete S_user] -> onReceive(Quote) -> Send(S_healed) by rebinding the same contextId to the healed session", async () => {
      const h = await createPermutationHarness({ withUserSession: true });
      try {
        // Step 1: Send from S_user -> allocates UUID ctx_u
        await h.manager.dispatchSend("wecom", USER_CREATED_SESSION_ID, {
          text: "Outbound before UI deletion",
        });
        const originalCtxId = h.wecom.sentMessages[0]!.context.contextId;

        // User deletes S_user in DSH UI
        h.host.deleteSessionInUi(USER_CREATED_SESSION_ID);

        // Step 2: External user Quote-replies with originalCtxId -> self-heals into S_healed
        const healedInbound = await receiveWecomWebhook(
          h.wecom,
          formatQuotedReply(h.wecom.sentMessages[0]!.wireText, "Reply after session deletion"),
        );
        expect(healedInbound.sessionId).not.toBe(USER_CREATED_SESSION_ID);
        expect(await h.store.getContext(USER_CREATED_SESSION_ID, "wecom")).toBeUndefined();

        // Step 3: Send from S_healed -> seamlessly reuses originalCtxId
        await h.manager.dispatchSend("wecom", healedInbound.sessionId, {
          text: "Continue conversation from healed session",
        });
        expect(h.wecom.sentMessages[1]!.context.contextId).toBe(originalCtxId);

        await assertExactMappingState({
          store: h.store,
          sessionDriver: h.sessionDriver,
          expectedBindings: [
            {
              sessionId: healedInbound.sessionId,
              connectorName: "wecom",
              contextId: originalCtxId,
            },
          ],
        });
      } finally {
        await h.cleanup();
      }
    });
  });
});
