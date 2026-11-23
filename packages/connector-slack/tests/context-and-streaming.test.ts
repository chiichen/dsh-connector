import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ConnectorTargetRequiredError,
  ConnectorValidationError,
  createConnectorContext,
} from "@dsh-connector/core";
import {
  DEFAULT_SLACK_API_BASE_URL,
  DEFAULT_SLACK_CONNECTOR_NAME,
  DEFAULT_SLACK_SIGNATURE_TOLERANCE_SEC,
  formatSlackContextId,
  parseSlackContextId,
  resolveSlackSendTarget,
  SLACK_MARKDOWN_TEXT_MAX_LENGTH,
  SLACK_TEXT_MAX_LENGTH,
  type SlackAgentSessionStatus,
  type SlackAppendStreamParams,
  type SlackAssistantThreadStatusParams,
  type SlackChatUpdateParams,
  type SlackStartStreamParams,
  type SlackStopStreamParams,
  type SlackStreamHandle,
  type SlackStreamingAdapter,
  type SlackStreamingOptions,
} from "../src";

describe("Stage 1: Slack constants, target/context addressing, and streaming extension seam", () => {
  it("exposes well-defined Slack protocol constants", () => {
    expect(DEFAULT_SLACK_CONNECTOR_NAME).toBe("slack");
    expect(DEFAULT_SLACK_API_BASE_URL).toBe("https://slack.com/api/");
    expect(DEFAULT_SLACK_SIGNATURE_TOLERANCE_SEC).toBe(300);
    expect(SLACK_TEXT_MAX_LENGTH).toBe(40_000);
    expect(SLACK_MARKDOWN_TEXT_MAX_LENGTH).toBe(12_000);
  });

  it("formats and parses DM and channel Slack context identifiers symmetrically", () => {
    const dmId = formatSlackContextId({ kind: "dm", channelId: "D0123456789" });
    expect(dmId).toBe("dm:D0123456789");
    expect(parseSlackContextId(dmId)).toEqual({
      kind: "dm",
      channelId: "D0123456789",
    });

    const dmThreadId = formatSlackContextId({
      kind: "dm",
      channelId: "D0123456789",
      threadTs: "1717171717.123456",
    });
    expect(dmThreadId).toBe("dm:D0123456789:1717171717.123456");
    expect(parseSlackContextId(dmThreadId)).toEqual({
      kind: "dm",
      channelId: "D0123456789",
      threadTs: "1717171717.123456",
    });

    const channelThreadId = formatSlackContextId({
      kind: "channel",
      channelId: "C0123456789",
      threadTs: "1717171717.000100",
    });
    expect(channelThreadId).toBe("channel:C0123456789:1717171717.000100");
    expect(parseSlackContextId(channelThreadId)).toEqual({
      kind: "channel",
      channelId: "C0123456789",
      threadTs: "1717171717.000100",
    });

    const channelRootId = formatSlackContextId({
      kind: "channel",
      channelId: "G0123456789",
    });
    expect(channelRootId).toBe("channel:G0123456789");
    expect(parseSlackContextId(channelRootId)).toEqual({
      kind: "channel",
      channelId: "G0123456789",
    });
  });

  it("rejects invalid Slack channel IDs or thread timestamps when formatting and returns undefined on non-Slack contextIds", () => {
    expect(() => formatSlackContextId({ kind: "dm", channelId: "invalid id!" })).toThrow(
      ConnectorValidationError,
    );
    expect(() =>
      formatSlackContextId({
        kind: "channel",
        channelId: "C0123456789",
        threadTs: "not-a-timestamp",
      }),
    ).toThrow(ConnectorValidationError);

    expect(parseSlackContextId("550e8400-e29b-41d4-a716-446655440000")).toBeUndefined();
    expect(parseSlackContextId("dm:")).toBeUndefined();
    expect(parseSlackContextId("channel:C0123456789:bad-ts")).toBeUndefined();
    expect(parseSlackContextId("channel:C0123456789:1717.1:extra")).toBeUndefined();
    expect(parseSlackContextId("unknown:C0123456789")).toBeUndefined();
  });

  it("resolves send target using 3-tier priority: explicit params > structured contextId > ConnectorTargetRequiredError", () => {
    const channelCtx = createConnectorContext("slack", "channel:C0123456789:1717171717.000100");
    const dmCtx = createConnectorContext("slack", "dm:D0123456789");
    const uuidCtx = createConnectorContext("slack", "550e8400-e29b-41d4-a716-446655440000");

    // 1. Explicit target overrides context onto another channel without leaking old threadTs
    expect(
      resolveSlackSendTarget(channelCtx, {
        channelId: "C9999999999",
      }),
    ).toEqual({
      channelId: "C9999999999",
    });

    // 1b. Explicit target with explicit threadTs
    expect(
      resolveSlackSendTarget(uuidCtx, {
        channelId: "C9999999999",
        threadTs: "1717171717.999999",
      }),
    ).toEqual({
      channelId: "C9999999999",
      threadTs: "1717171717.999999",
    });

    // 1c. Explicit channelId matching current context preserves thread affinity unless overridden
    expect(
      resolveSlackSendTarget(channelCtx, {
        channelId: "C0123456789",
      }),
    ).toEqual({
      channelId: "C0123456789",
      threadTs: "1717171717.000100",
    });

    // 2. Structured contextId fallback
    expect(resolveSlackSendTarget(channelCtx, {})).toEqual({
      channelId: "C0123456789",
      threadTs: "1717171717.000100",
    });
    expect(resolveSlackSendTarget(dmCtx, {})).toEqual({
      channelId: "D0123456789",
    });
    expect(resolveSlackSendTarget(dmCtx, { threadTs: "1717171717.222222" })).toEqual({
      channelId: "D0123456789",
      threadTs: "1717171717.222222",
    });

    // 3. Unstructured UUID context without explicit channelId throws ConnectorTargetRequiredError
    expect(() => resolveSlackSendTarget(uuidCtx, {})).toThrow(ConnectorTargetRequiredError);

    // Invalid explicit channelId or threadTs throws ConnectorValidationError
    expect(() => resolveSlackSendTarget(uuidCtx, { channelId: "bad id" })).toThrow(
      ConnectorValidationError,
    );
    expect(() =>
      resolveSlackSendTarget(dmCtx, {
        threadTs: "bad-ts",
      }),
    ).toThrow(ConnectorValidationError);
  });

  it("defines strictly typed streaming extension contracts for chat.update, assistant.threads.setStatus, and chat.startStream/appendStream/stopStream", async () => {
    const mockAdapter: SlackStreamingAdapter = {
      async setAssistantThreadStatus(params) {
        expectTypeOf(params).toEqualTypeOf<SlackAssistantThreadStatusParams>();
        return { ok: true };
      },
      async updateMessage(params) {
        expectTypeOf(params).toEqualTypeOf<SlackChatUpdateParams>();
        return { ok: true, channel: params.channel, ts: params.ts };
      },
      async startStream(target, initial) {
        const wireReq: SlackStartStreamParams = {
          channel: target.channelId,
          ...(target.threadTs !== undefined ? { thread_ts: target.threadTs } : {}),
          ...(initial?.markdownText !== undefined ? { markdown_text: initial.markdownText } : {}),
        };
        expect(wireReq.channel).toBe("C0123456789");
        return {
          channelId: target.channelId,
          messageTs: "1717171717.500000",
          ...(target.threadTs !== undefined ? { threadTs: target.threadTs } : {}),
          mode: "native-stream",
        };
      },
      async appendStream(handle, update) {
        const wireReq: SlackAppendStreamParams = {
          channel: handle.channelId,
          ts: handle.messageTs,
          ...(update.markdownText !== undefined ? { markdown_text: update.markdownText } : {}),
        };
        return { ok: true, channel: wireReq.channel, ts: wireReq.ts };
      },
      async completeStream(handle, final) {
        const status: SlackAgentSessionStatus = final?.sessionStatus ?? "active";
        const wireReq: SlackStopStreamParams = {
          channel: handle.channelId,
          ts: handle.messageTs,
          session_status: status,
        };
        return { ok: true, channel: wireReq.channel, ts: wireReq.ts };
      },
    };

    const streamingOpts: SlackStreamingOptions = {
      preferredMode: "native-stream",
      throttleMs: 350,
      defaultLoadingMessages: ["Thinking..."],
      adapter: mockAdapter,
    };

    const handle: SlackStreamHandle = await streamingOpts.adapter!.startStream(
      { channelId: "C0123456789", threadTs: "1717171717.000100" },
      { markdownText: "Starting..." },
    );
    expect(handle.messageTs).toBe("1717171717.500000");

    const appended = await streamingOpts.adapter!.appendStream(handle, {
      markdownText: " More text",
    });
    expect(appended.ok).toBe(true);

    const stopped = await streamingOpts.adapter!.completeStream(handle, {
      sessionStatus: "active",
    });
    expect(stopped.ok).toBe(true);
  });
});
