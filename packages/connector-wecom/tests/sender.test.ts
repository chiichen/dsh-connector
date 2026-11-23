import { describe, expect, it, vi } from "vitest";
import {
  ConnectorAuthError,
  ConnectorTargetRequiredError,
  ConnectorTransportError,
  createConnectorContext,
} from "@dsh-connector/core";
import { WeComApiClient } from "../src/api-client";
import { WeComSender, type WeComAibotOutboundTransport } from "../src/sender";
import { wecomSendSchema } from "../src/types";

interface MockFetchCall {
  readonly url: string;
  readonly method: string;
  readonly bodyText: string | undefined;
}

function createMockFetch(
  responder: (
    call: MockFetchCall,
    index: number,
  ) => { status?: number; json?: unknown; text?: string },
): { fetchFn: typeof fetch; calls: MockFetchCall[] } {
  const calls: MockFetchCall[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input.toString() : String(input);
    const method = init?.method ?? "GET";
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    const call: MockFetchCall = { url, method, bodyText };
    calls.push(call);
    const reply = responder(call, calls.length - 1);
    const status = reply.status ?? 200;
    const rawText = reply.text ?? JSON.stringify(reply.json ?? { errcode: 0, errmsg: "ok" });
    return new Response(rawText, {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchFn, calls };
}

describe("Stage 2: WeComApiClient & WeComSender outbound channels", () => {
  it("caches gettoken access_token, coalesces concurrent requests, and retries once on 40014/42001", async () => {
    let tokenCounter = 0;
    let firstMessageAttempt = true;
    const { fetchFn, calls } = createMockFetch((call) => {
      if (call.url.includes("/cgi-bin/gettoken")) {
        tokenCounter += 1;
        return {
          json: {
            errcode: 0,
            errmsg: "ok",
            access_token: `tok_${tokenCounter}`,
            expires_in: 7200,
          },
        };
      }
      if (call.url.includes("/cgi-bin/message/send")) {
        if (firstMessageAttempt) {
          firstMessageAttempt = false;
          return { json: { errcode: 42001, errmsg: "access_token expired" } };
        }
        return { json: { errcode: 0, errmsg: "ok", msgid: "msg_after_refresh" } };
      }
      return { json: { errcode: 0, errmsg: "ok" } };
    });

    const client = new WeComApiClient({
      app: { corpId: "ww_corp", corpSecret: "sec_123", agentId: 1000002 },
      fetchFn,
    });

    // Coalesces concurrent gettoken calls
    const [t1, t2] = await Promise.all([client.getAccessToken(), client.getAccessToken()]);
    expect(t1).toBe("tok_1");
    expect(t2).toBe("tok_1");
    expect(calls.filter((c) => c.url.includes("/cgi-bin/gettoken"))).toHaveLength(1);

    // First send hits 42001 -> invalidates tok_1 -> fetches tok_2 -> succeeds!
    const res = await client.sendAppMessage({
      touser: "zhangsan",
      msgtype: "text",
      text: { content: "hello" },
    });
    expect(res.msgid).toBe("msg_after_refresh");
    expect(tokenCounter).toBe(2);
    expect(calls.at(-1)?.url).toContain("access_token=tok_2");
  });

  it("sends self-built app messages, appchat group messages, and auto-splits >2048 UTF-8 bytes", async () => {
    const { fetchFn, calls } = createMockFetch((call, idx) => {
      if (call.url.includes("/cgi-bin/gettoken")) {
        return { json: { errcode: 0, errmsg: "ok", access_token: "app_tok", expires_in: 7200 } };
      }
      return { json: { errcode: 0, errmsg: "ok", msgid: `m_${idx}` } };
    });

    const apiClient = new WeComApiClient({
      app: {
        corpId: "ww_corp",
        corpSecret: "sec_123",
        agentId: "1000005",
        enableDuplicateCheck: true,
        duplicateCheckIntervalSeconds: 600,
      },
      fetchFn,
    });
    const sender = new WeComSender({
      connectorName: "wecom",
      apiClient,
    });

    // Tier 2 context fallback: app:p2p:zhangsan with >2048 UTF-8 bytes (800 CJK chars = 2400 bytes)
    const longCjk = "测".repeat(800);
    const p2pCtx = createConnectorContext("wecom", "app:p2p:zhangsan");
    const p2pResult = await sender.send(
      p2pCtx,
      wecomSendSchema.parse({ text: longCjk, safe: true }),
    );
    expect(p2pResult.channel).toBe("app");
    expect(p2pResult.target).toBe("zhangsan");
    expect(p2pResult.chunkCount).toBe(2);
    expect(p2pResult.messageId).toBe("m_2");

    const messageSendCalls = calls.filter((c) => c.url.includes("/cgi-bin/message/send"));
    expect(messageSendCalls).toHaveLength(2);
    const firstBody = JSON.parse(messageSendCalls[0]!.bodyText!) as Record<string, unknown>;
    expect(firstBody["agentid"]).toBe(1000005);
    expect(firstBody["touser"]).toBe("zhangsan");
    expect(firstBody["safe"]).toBe(1);
    expect(firstBody["enable_duplicate_check"]).toBe(1);

    // Tier 2 context fallback: app:group:wr_group_1 -> routes to /cgi-bin/appchat/send
    const groupCtx = createConnectorContext("wecom", "app:group:wr_group_1");
    const groupResult = await sender.send(
      groupCtx,
      wecomSendSchema.parse({
        text: "群通知",
        mentionedList: ["lisi", "@all"],
        includeContextMarker: true,
      }),
    );
    expect(groupResult.channel).toBe("appchat");
    expect(groupResult.target).toBe("wr_group_1");
    const appChatCalls = calls.filter((c) => c.url.includes("/cgi-bin/appchat/send"));
    expect(appChatCalls).toHaveLength(1);
    const groupBody = JSON.parse(appChatCalls[0]!.bodyText!) as {
      chatid: string;
      text: { content: string; mentioned_list: string[] };
    };
    expect(groupBody.chatid).toBe("wr_group_1");
    expect(groupBody.text.mentioned_list).toEqual(["lisi", "@all"]);
    expect(groupBody.text.content).toContain("app:group:wr_group_1");
  });

  it("sends group webhook bot messages (text & markdown_v2) and Intelligent Bot messages (WS & response_url)", async () => {
    const { fetchFn, calls } = createMockFetch((call) => {
      if (call.url.includes("/cgi-bin/webhook/send")) {
        return { json: { errcode: 0, errmsg: "ok" } };
      }
      if (call.url.startsWith("https://qyapi.weixin.qq.com/cgi-bin/aibot/response")) {
        return { json: { errcode: 0, errmsg: "ok" } };
      }
      return { json: { errcode: 0, errmsg: "ok" } };
    });

    const sendProactiveMarkdown = vi.fn(async () => ({ reqId: "ws_req_1", raw: { errcode: 0 } }));
    const respondMarkdown = vi.fn(async () => ({ reqId: "cb_req_9", raw: { errcode: 0 } }));
    const cachedUrls = new Map<string, string>([
      ["aibot:p2p:user_http", "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?code=1"],
    ]);

    const aibotTransport: WeComAibotOutboundTransport = {
      isConnected: () => true,
      sendProactiveMarkdown,
      respondMarkdown,
      consumeCachedResponseUrl: (ctxId) => {
        const found = cachedUrls.get(ctxId);
        cachedUrls.delete(ctxId);
        return found;
      },
    };

    const apiClient = new WeComApiClient({ fetchFn });
    const sender = new WeComSender({
      connectorName: "wecom",
      apiClient,
      aibotTransport,
    });

    // Webhook send via explicit webhookKey
    const uuidCtx = createConnectorContext("wecom", "550e8400-e29b-41d4-a716-446655440000");
    const whRes = await sender.send(
      uuidCtx,
      wecomSendSchema.parse({
        text: "# 标题\n告警恢复",
        webhookKey: "wh-key-123",
        format: "markdown_v2",
      }),
    );
    expect(whRes.channel).toBe("webhook");
    expect(calls[0]?.url).toContain("/cgi-bin/webhook/send?key=wh-key-123");
    expect(JSON.parse(calls[0]!.bodyText!)).toEqual({
      msgtype: "markdown_v2",
      markdown_v2: { content: "# 标题\n告警恢复" },
    });

    // Intelligent Bot via cached HTTP response_url
    const httpBotCtx = createConnectorContext("wecom", "aibot:p2p:user_http");
    const respUrlRes = await sender.send(httpBotCtx, wecomSendSchema.parse({ text: "HTTP 回复" }));
    expect(respUrlRes.channel).toBe("aibot");
    expect(calls[1]?.url).toBe("https://qyapi.weixin.qq.com/cgi-bin/aibot/response?code=1");

    // Intelligent Bot via WebSocket proactive send (`aibot:group:chat_ws`)
    const wsGroupCtx = createConnectorContext("wecom", "aibot:group:chat_ws");
    const wsProactiveRes = await sender.send(
      wsGroupCtx,
      wecomSendSchema.parse({ text: "WS 群主动消息" }),
    );
    expect(wsProactiveRes.channel).toBe("aibot");
    expect(wsProactiveRes.reqId).toBe("ws_req_1");
    expect(sendProactiveMarkdown).toHaveBeenCalledWith(
      { chatId: "chat_ws", chatType: 2, content: "WS 群主动消息" },
      undefined,
    );

    // Intelligent Bot via WebSocket callback `reqId` (`aibot_respond_msg`)
    const wsReplyRes = await sender.send(
      wsGroupCtx,
      wecomSendSchema.parse({ text: "WS 被动关联回复", reqId: "cb_req_9" }),
    );
    expect(wsReplyRes.reqId).toBe("cb_req_9");
    expect(respondMarkdown).toHaveBeenCalledWith(
      { reqId: "cb_req_9", content: "WS 被动关联回复" },
      undefined,
    );
  });

  it("enforces 3-tier target priority and maps auth/transport errors accurately", async () => {
    const { fetchFn } = createMockFetch((call) => {
      if (call.url.includes("bad_secret")) {
        return { json: { errcode: 40001, errmsg: "invalid credential" } };
      }
      return { status: 502, text: "Bad Gateway" };
    });

    const senderNoCreds = new WeComSender({
      connectorName: "wecom",
      apiClient: new WeComApiClient({ fetchFn }),
    });

    // Pure pre-allocated UUID context without explicit target throws ConnectorTargetRequiredError
    const uuidCtx = createConnectorContext("wecom", "550e8400-e29b-41d4-a716-446655440000");
    await expect(
      senderNoCreds.send(uuidCtx, wecomSendSchema.parse({ text: "orphan" })),
    ).rejects.toThrow(ConnectorTargetRequiredError);

    // Auth error mapping (40001)
    const badAuthClient = new WeComApiClient({
      app: { corpId: "ww1", corpSecret: "bad_secret", agentId: 1 },
      fetchFn,
    });
    await expect(badAuthClient.getAccessToken()).rejects.toThrow(ConnectorAuthError);

    // HTTP 502 non-JSON error mapping -> retryable ConnectorTransportError
    const gatewayErrClient = new WeComApiClient({ fetchFn });
    await expect(
      gatewayErrClient.sendWebhookMessage("k1", {
        msgtype: "text",
        text: { content: "hi" },
      }),
    ).rejects.toThrow(ConnectorTransportError);

    // Additional validation & explicit target branches (markdown, webhook context, aibot disconnected, abort, invalid JSON)
    expect(
      () =>
        new WeComApiClient({
          app: { corpId: "ww1", corpSecret: "s", agentId: "not-a-number" },
        }),
    ).toThrow(/agentId/);
    expect(
      () =>
        new WeComApiClient({
          app: { corpId: "ww1", corpSecret: "s", agentId: 1, apiBaseUrl: "ftp://bad" },
        }),
    ).toThrow(/http/);

    const noCredClient = new WeComApiClient({ fetchFn });
    await expect(noCredClient.getAccessToken()).rejects.toThrow(/requires self-built app/);
    await expect(
      noCredClient.sendAppMessage({ touser: "u", msgtype: "text", text: { content: "x" } }),
    ).rejects.toThrow(/not configured/);
    await expect(
      noCredClient.sendWebhookMessage("   ", { msgtype: "text", text: { content: "x" } }),
    ).rejects.toThrow(/webhookKey/);
    await expect(
      noCredClient.sendResponseUrlMessage("not-url", {
        msgtype: "markdown",
        markdown: { content: "x" },
      }),
    ).rejects.toThrow(/response_url/);

    const { fetchFn: richFetch } = createMockFetch((call) => {
      if (call.url.includes("invalid_json")) {
        return { text: "{broken" };
      }
      if (call.url.includes("array_json")) {
        return { text: "[1,2]" };
      }
      if (call.url.includes("biz_error")) {
        return { json: { errcode: 81013, errmsg: "all invalid user" } };
      }
      if (call.url.includes("/cgi-bin/gettoken")) {
        return {
          json: { errcode: 0, errmsg: "ok", access_token: "short_tok", expires_in: 60 },
        };
      }
      return {
        json: { errcode: 0, errmsg: "ok", msgid: "m_ok", response_code: "rc_1" },
      };
    });

    const richClient = new WeComApiClient({
      app: { corpId: "ww1", corpSecret: "sec", agentId: 10 },
      fetchFn: richFetch,
    });
    await expect(
      richClient.sendResponseUrlMessage("https://example.com/invalid_json", {
        msgtype: "markdown",
        markdown: { content: "x" },
      }),
    ).rejects.toThrow(/invalid JSON/);
    await expect(
      richClient.sendResponseUrlMessage("https://example.com/array_json", {
        msgtype: "markdown",
        markdown: { content: "x" },
      }),
    ).rejects.toThrow(/non-object/);
    await expect(
      richClient.sendResponseUrlMessage("https://example.com/biz_error", {
        msgtype: "markdown",
        markdown: { content: "x" },
      }),
    ).rejects.toThrow(/81013/);

    const aborted = new AbortController();
    aborted.abort(new Error("cancelled"));
    await expect(
      richClient.sendWebhookMessage(
        "k1",
        { msgtype: "text", text: { content: "x" } },
        { signal: aborted.signal },
      ),
    ).rejects.toThrow(ConnectorTransportError);

    const richSender = new WeComSender({
      connectorName: "wecom",
      apiClient: richClient,
    });

    // Explicit app markdown, appchat markdown, webhook context with markdown & text mentions, explicit responseUrl
    const mdAppRes = await richSender.send(
      uuidCtx,
      wecomSendSchema.parse({
        text: "**Markdown**",
        toUser: "u1",
        toParty: "p1",
        toTag: "t1",
        format: "markdown",
      }),
    );
    expect(mdAppRes.responseCode).toBe("rc_1");

    const mdChatRes = await richSender.send(
      uuidCtx,
      wecomSendSchema.parse({
        text: "**Group MD**",
        chatId: "chat_1",
        format: "markdown",
      }),
    );
    expect(mdChatRes.channel).toBe("appchat");

    const whCtx = createConnectorContext("wecom", "webhook:ctx_key");
    await richSender.send(
      whCtx,
      wecomSendSchema.parse({
        text: "wh text",
        mentionedList: ["u1"],
        mentionedMobileList: ["13800001111"],
      }),
    );
    await richSender.send(
      whCtx,
      wecomSendSchema.parse({
        text: "wh md",
        format: "markdown",
      }),
    );
    await richSender.send(
      uuidCtx,
      wecomSendSchema.parse({
        text: "direct resp url",
        responseUrl: "https://example.com/ok_resp",
      }),
    );

    // Disconnected aibot transport rejects with retryable ConnectorTransportError
    const aibotOnlySender = new WeComSender({
      connectorName: "wecom",
      apiClient: noCredClient,
      defaultConversationChannel: "aibot",
    });
    await expect(
      aibotOnlySender.send(uuidCtx, wecomSendSchema.parse({ text: "hello", toUser: "u_single" })),
    ).rejects.toThrow(/not connected/);
    await expect(
      aibotOnlySender.send(
        uuidCtx,
        wecomSendSchema.parse({ text: "hello", channel: "aibot", chatId: "g_1" }),
      ),
    ).rejects.toThrow(/not connected/);
    await expect(
      aibotOnlySender.send(uuidCtx, wecomSendSchema.parse({ text: "hello", chatId: "g_default" })),
    ).rejects.toThrow(/not connected/);
    await expect(
      aibotOnlySender.send(
        uuidCtx,
        wecomSendSchema.parse({
          text: "x".repeat(20_500),
          responseUrl: "https://example.com/ok_resp",
        }),
      ),
    ).rejects.toThrow(/single message/);
  });
});
