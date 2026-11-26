import { describe, expect, it, vi } from "vitest";
import {
  createDefaultContextIdGenerator,
  prependContextMarker,
  type ConnectorContext,
  type ConnectorLogger,
  type ConnectorReceiverContext,
  type ConnectorWebhookRequest,
  type InboundDeliveryMeta,
} from "@dsh-connector/core";
import { WeComMsgCrypt, extractEncryptedCallbackEnvelope } from "../src/crypto";
import { WeComReceiver } from "../src/receiver";
import { buildPassiveStreamReplyPayload, type WeComStreamingAdapter } from "../src/streaming";
import type { WeComReceiveParams } from "../src/types";

const TOKEN = "cb_token_stage3";
const ENCODING_AES_KEY = "jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C";
const CORP_ID = "ww_corp_stage3";

function createSilentLogger(): ConnectorLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function createHarness() {
  const received: Array<{
    context: ConnectorContext<"wecom">;
    params: WeComReceiveParams;
    meta: InboundDeliveryMeta | undefined;
  }> = [];
  const gen = createDefaultContextIdGenerator();
  const receiverCtx: ConnectorReceiverContext<
    typeof import("../src/types").wecomReceiveSchema,
    "wecom"
  > = {
    allocateContextId: () => gen.generate("wecom"),
    contextIdGenerator: gen,
    logger: createSilentLogger(),
    onReceive: async (context, params, meta) => {
      received.push({ context, params: params as WeComReceiveParams, meta });
      return { sessionId: `sess_${received.length}` };
    },
  };
  return { received, receiverCtx };
}

function makeWebhookReq(input: {
  method: "GET" | "POST" | "PUT";
  query?: Record<string, string>;
  bodyText?: string;
}): ConnectorWebhookRequest {
  return {
    method: input.method,
    pathname: "/webhooks/wecom",
    subPath: "/",
    query: new URLSearchParams(input.query ?? {}),
    headers: {},
    rawBody: new TextEncoder().encode(input.bodyText ?? ""),
  };
}

describe("Stage 3: WeComReceiver HTTP Callback (GET echostr + POST XML/JSON)", () => {
  it("handles GET echostr URL verification and rejects invalid methods, missing params, or bad signatures", async () => {
    const appCrypt = new WeComMsgCrypt({
      token: TOKEN,
      encodingAesKey: ENCODING_AES_KEY,
      receiveId: CORP_ID,
    });
    const receiver = new WeComReceiver({
      connectorName: "wecom",
      appCorpId: CORP_ID,
      callback: { token: TOKEN, encodingAesKey: ENCODING_AES_KEY },
    });
    const { receiverCtx } = createHarness();
    await receiver.init(receiverCtx);

    const timestamp = "1700001000";
    const nonce = "nonce_get_1";
    const echostr = appCrypt.encrypt("plain_echo_challenge_2026");
    const msgSignature = appCrypt.sign(timestamp, nonce, echostr);

    const okRes = await receiver.handleWebhook(
      makeWebhookReq({
        method: "GET",
        query: { msg_signature: msgSignature, timestamp, nonce, echostr },
      }),
    );
    expect(okRes.status).toBe(200);
    expect(okRes.body).toBe("plain_echo_challenge_2026");

    // 405 on PUT
    const putRes = await receiver.handleWebhook(makeWebhookReq({ method: "PUT" }));
    expect(putRes.status).toBe(405);

    // 400 on missing query
    const badQueryRes = await receiver.handleWebhook(
      makeWebhookReq({ method: "GET", query: { timestamp } }),
    );
    expect(badQueryRes.status).toBe(400);

    // 401 on bad signature
    const badSigRes = await receiver.handleWebhook(
      makeWebhookReq({
        method: "GET",
        query: { msg_signature: "0".repeat(40), timestamp, nonce, echostr },
      }),
    );
    expect(badSigRes.status).toBe(401);

    // 503 when callback crypto is not configured
    const unconfiguredReceiver = new WeComReceiver({ connectorName: "wecom" });
    const unconfiguredRes = await unconfiguredReceiver.handleWebhook(
      makeWebhookReq({ method: "GET" }),
    );
    expect(unconfiguredRes.status).toBe(503);
  });

  it("decrypts Self-Built App XML POST callbacks, filters bot self-messages & events, and binds context", async () => {
    const appCrypt = new WeComMsgCrypt({
      token: TOKEN,
      encodingAesKey: ENCODING_AES_KEY,
      receiveId: CORP_ID,
    });
    const receiver = new WeComReceiver({
      connectorName: "wecom",
      appCorpId: CORP_ID,
      selfUserIds: ["wecom_bot_self"],
      callback: { token: TOKEN, encodingAesKey: ENCODING_AES_KEY },
      inboundDeliveryMode: "steer",
    });
    const { received, receiverCtx } = createHarness();
    await receiver.init(receiverCtx);

    const timestamp = "1700002000";
    const nonce = "nonce_xml_1";

    // Normal text XML message from user `zhangsan`
    const xmlPlain = [
      "<xml>",
      `<ToUserName><![CDATA[${CORP_ID}]]></ToUserName>`,
      "<FromUserName><![CDATA[zhangsan]]></FromUserName>",
      "<CreateTime>1700002000</CreateTime>",
      "<MsgType><![CDATA[text]]></MsgType>",
      "<Content><![CDATA[请帮我检查部署流水线]]></Content>",
      "<MsgId>9988776655</MsgId>",
      "<AgentID>1000002</AgentID>",
      "</xml>",
    ].join("");
    const xmlEnvelope = appCrypt.encryptReply({
      plaintext: xmlPlain,
      timestamp,
      nonce,
      format: "xml",
    });

    const postRes = await receiver.handleWebhook(
      makeWebhookReq({
        method: "POST",
        query: { timestamp, nonce },
        bodyText: xmlEnvelope,
      }),
    );
    expect(postRes.status).toBe(200);
    expect(postRes.body).toBe("");
    expect(received).toHaveLength(1);
    expect(received[0]?.context.contextId).toBe("msg:9988776655");
    expect(received[0]?.params).toMatchObject({
      source: "app-webhook",
      messageId: "9988776655",
      msgType: "text",
      senderId: "zhangsan",
      chatType: "single",
      text: "请帮我检查部署流水线",
      agentId: "1000002",
    });
    expect(received[0]?.meta).toMatchObject({
      idempotencyKey: "9988776655",
      deliveryMode: "steer",
    });

    const prompt = receiver.formatInbound(received[0]!.params, received[0]!.context);
    expect(prompt.text).toContain("zhangsan");
    expect(prompt.text).toContain("请帮我检查部署流水线");

    // Self-message from `wecom_bot_self` must be filtered out (anti-loop)
    const selfXml = xmlPlain
      .replace("zhangsan", "wecom_bot_self")
      .replace("9988776655", "9988776656");
    const selfRes = await receiver.handleWebhook(
      makeWebhookReq({
        method: "POST",
        bodyText: appCrypt.encryptReply({ plaintext: selfXml, timestamp, nonce, format: "xml" }),
      }),
    );
    expect(selfRes.status).toBe(200);
    expect(received).toHaveLength(1);

    // Event callback (`MsgType = event`) is acknowledged 200 without triggering onReceive
    const eventXml = [
      "<xml>",
      `<ToUserName><![CDATA[${CORP_ID}]]></ToUserName>`,
      "<FromUserName><![CDATA[zhangsan]]></FromUserName>",
      "<CreateTime>1700002005</CreateTime>",
      "<MsgType><![CDATA[event]]></MsgType>",
      "<Event><![CDATA[enter_agent]]></Event>",
      "</xml>",
    ].join("");
    const eventRes = await receiver.handleWebhook(
      makeWebhookReq({
        method: "POST",
        bodyText: appCrypt.encryptReply({ plaintext: eventXml, timestamp, nonce, format: "xml" }),
      }),
    );
    expect(eventRes.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  it("decrypts Intelligent Bot JSON callbacks, extracts quoted context markers, caches response_url, and handles stream refresh seam", async () => {
    const aibotCrypt = new WeComMsgCrypt({
      token: TOKEN,
      encodingAesKey: ENCODING_AES_KEY,
      receiveId: "",
    });
    const getSnapshot = vi.fn((streamId: string) =>
      streamId === "live_stream_1"
        ? buildPassiveStreamReplyPayload({
            streamId,
            content: "流式快照内容",
            finish: true,
          })
        : undefined,
    );
    const mockStreamAdapter: WeComStreamingAdapter = {
      startStream: async (target) => ({
        streamId: "live_stream_1",
        target,
        startedAt: 1,
        expiresAt: 2,
      }),
      updateStream: async () => {},
      completeStream: async () => {},
      abortStream: async () => {},
      getPassiveStreamSnapshot: getSnapshot,
    };

    const receiver = new WeComReceiver({
      connectorName: "wecom",
      callback: { token: TOKEN, encodingAesKey: ENCODING_AES_KEY },
      botMentionNames: ["RobotA"],
      requireMentionInGroup: true,
      streamingAdapter: mockStreamAdapter,
    });
    const { received, receiverCtx } = createHarness();
    await receiver.init(receiverCtx);

    const timestamp = "1700003000";
    const nonce = "nonce_json_1";

    // Group mixed message quoting a message that carries a DSH context marker
    const quotedWithMarker = prependContextMarker(
      "之前的告警消息",
      "custom:incident-42",
      "bracket",
    );
    const jsonPlain = JSON.stringify({
      msgid: "aibot_msg_101",
      aibotid: "bot_a1",
      chatid: "group_ops_1",
      chattype: "group",
      from: { userid: "lisi" },
      response_url: "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=rc_101",
      msgtype: "mixed",
      mixed: {
        msg_item: [
          { msgtype: "text", text: { content: "@RobotA 继续排查这个问题" } },
          { msgtype: "image", image: { url: "https://cos.example.com/img1.png" } },
        ],
      },
      quote: {
        msgtype: "text",
        text: { content: quotedWithMarker },
      },
    });
    const jsonEnvelope = aibotCrypt.encryptReply({
      plaintext: jsonPlain,
      timestamp,
      nonce,
      format: "json",
    });

    const res = await receiver.handleWebhook(
      makeWebhookReq({
        method: "POST",
        bodyText: jsonEnvelope,
      }),
    );
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    // Bound to extracted context marker from quote!
    expect(received[0]?.context.contextId).toBe("custom:incident-42");
    expect(received[0]?.params.text).toBe("继续排查这个问题");
    expect(received[0]?.params.mediaUrl).toBe("https://cos.example.com/img1.png");

    // Cached single-use response_url can be consumed once
    expect(receiver.consumeCachedResponseUrl("custom:incident-42")).toBe(
      "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=rc_101",
    );
    expect(receiver.consumeCachedResponseUrl("custom:incident-42")).toBeUndefined();

    // Group message without @RobotA when requireMentionInGroup = true is ignored
    const unmentionedJson = JSON.stringify({
      msgid: "aibot_msg_102",
      aibotid: "bot_a1",
      chatid: "group_ops_1",
      chattype: "group",
      from: { userid: "lisi" },
      msgtype: "text",
      text: { content: "大家中午吃什么" },
    });
    await receiver.handleWebhook(
      makeWebhookReq({
        method: "POST",
        bodyText: aibotCrypt.encryptReply({
          plaintext: unmentionedJson,
          timestamp,
          nonce,
          format: "json",
        }),
      }),
    );
    expect(received).toHaveLength(1);

    // Passive stream refresh poll (`msgtype: "stream"`) delegates to streamingAdapter seam and returns encrypted JSON
    const streamRefreshJson = JSON.stringify({
      msgid: "stream_poll_1",
      aibotid: "bot_a1",
      chattype: "single",
      from: { userid: "lisi" },
      msgtype: "stream",
      stream: { id: "live_stream_1" },
    });
    const refreshRes = await receiver.handleWebhook(
      makeWebhookReq({
        method: "POST",
        bodyText: aibotCrypt.encryptReply({
          plaintext: streamRefreshJson,
          timestamp,
          nonce,
          format: "json",
        }),
      }),
    );
    expect(refreshRes.status).toBe(200);
    expect(getSnapshot).toHaveBeenCalledOnce();
    const replyEnv = extractEncryptedCallbackEnvelope(String(refreshRes.body));
    expect(replyEnv?.format).toBe("json");
    const decryptedReply = aibotCrypt.decryptCallback({
      msgSignature: replyEnv!.msgSignature!,
      timestamp: replyEnv!.timestamp!,
      nonce: replyEnv!.nonce!,
      encrypt: replyEnv!.encrypt,
    });
    expect(JSON.parse(decryptedReply.message)).toMatchObject({
      msgtype: "stream",
      stream: { id: "live_stream_1", finish: true, content: "流式快照内容" },
    });
    // Stream refresh never invokes onReceive
    expect(received).toHaveLength(1);
  });

  it("covers XML media/location/link/voice shapes, JSON quote/media variants, error status codes, and response_url cache eviction/TTL", async () => {
    let clockMs = 1_700_000_000_000;
    const appCrypt = new WeComMsgCrypt({
      token: TOKEN,
      encodingAesKey: ENCODING_AES_KEY,
      receiveId: CORP_ID,
    });
    const aibotCrypt = new WeComMsgCrypt({
      token: TOKEN,
      encodingAesKey: ENCODING_AES_KEY,
      receiveId: "",
    });
    const receiver = new WeComReceiver({
      connectorName: "wecom",
      appCorpId: CORP_ID,
      appAgentId: 1000009,
      aibotId: "aibot_self",
      callback: { token: TOKEN, encodingAesKey: ENCODING_AES_KEY },
      responseUrlCacheLimit: 2,
      now: () => clockMs,
    });
    const { received, receiverCtx } = createHarness();
    await receiver.init(receiverCtx);

    const ts = "1700004000";
    const nonce = "nonce_edge";

    // POST malformed body, missing sig, bad sig
    expect(
      (await receiver.handleWebhook(makeWebhookReq({ method: "POST", bodyText: "plain" }))).status,
    ).toBe(400);
    const encOnlyJson = JSON.stringify({ encrypt: aibotCrypt.encrypt("{}") });
    expect(
      (await receiver.handleWebhook(makeWebhookReq({ method: "POST", bodyText: encOnlyJson })))
        .status,
    ).toBe(400);
    expect(
      (
        await receiver.handleWebhook(
          makeWebhookReq({
            method: "POST",
            query: { msg_signature: "0".repeat(40), timestamp: ts, nonce },
            bodyText: encOnlyJson,
          }),
        )
      ).status,
    ).toBe(401);

    // Invalid JSON inside encrypted Intelligent Bot callback -> 400
    expect(
      (
        await receiver.handleWebhook(
          makeWebhookReq({
            method: "POST",
            bodyText: aibotCrypt.encryptReply({
              plaintext: "{not-json",
              timestamp: ts,
              nonce,
              format: "json",
            }),
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await receiver.handleWebhook(
          makeWebhookReq({
            method: "POST",
            bodyText: aibotCrypt.encryptReply({
              plaintext: "[1,2]",
              timestamp: ts,
              nonce,
              format: "json",
            }),
          }),
        )
      ).status,
    ).toBe(400);

    // XML group voice, location, link, and image messages
    const xmlPayloads = [
      `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><FromUserName><![CDATA[u1]]></FromUserName><ChatId><![CDATA[grp_1]]></ChatId><MsgType><![CDATA[voice]]></MsgType><Recognition><![CDATA[语音识别结果]]></Recognition><MediaId><![CDATA[mid_1]]></MediaId></xml>`,
      `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><FromUserName><![CDATA[u2]]></FromUserName><MsgType><![CDATA[location]]></MsgType><Label><![CDATA[深圳市南山区]]></Label></xml>`,
      `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><FromUserName><![CDATA[u3]]></FromUserName><MsgType><![CDATA[link]]></MsgType><Title><![CDATA[文档链接]]></Title><Url><![CDATA[https://work.weixin.qq.com]]></Url></xml>`,
      `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><FromUserName><![CDATA[u4]]></FromUserName><MsgType><![CDATA[image]]></MsgType><PicUrl><![CDATA[https://img.example.com/1.jpg]]></PicUrl><MediaId><![CDATA[mid_2]]></MediaId></xml>`,
    ];
    for (const xml of xmlPayloads) {
      await receiver.handleWebhook(
        makeWebhookReq({
          method: "POST",
          bodyText: appCrypt.encryptReply({ plaintext: xml, timestamp: ts, nonce, format: "xml" }),
        }),
      );
    }
    expect(received).toHaveLength(4);
    expect(received[0]?.context.contextId).toBe("msg:u1:1700000000000");
    expect(received[0]?.params.text).toBe("语音识别结果");
    expect(received[1]?.params.text).toContain("深圳市南山区");
    expect(received[2]?.params.text).toContain("文档链接");

    // formatInbound with group, quote, mediaId, mediaUrl
    const formattedMediaId = receiver.formatInbound(received[0]!.params, received[0]!.context);
    expect(formattedMediaId.text).toContain("[media_id: mid_1]");
    expect(formattedMediaId.title).toContain("WeCom Group grp_1");
    const formattedMediaUrl = receiver.formatInbound(received[3]!.params, received[3]!.context);
    expect(formattedMediaUrl.text).toContain("[media_url: https://img.example.com/1.jpg]");

    // JSON image/quote(voice & mixed)/event/stream(no adapter) & responseUrl cache eviction + TTL expiry
    const jsonMsgs = [
      {
        msgid: "j1",
        aibotid: "b1",
        chattype: "single",
        from: { userid: "ju1" },
        response_url: "https://example.com/r1",
        msgtype: "image",
        image: { url: "https://example.com/i1.png" },
        quote: { msgtype: "voice", voice: { content: "引用语音" } },
      },
      {
        msgid: "j2",
        aibotid: "b1",
        chattype: "single",
        from: { userid: "ju2" },
        response_url: "https://example.com/r2",
        msgtype: "video",
        video: { url: "https://example.com/v2.mp4" },
        quote: {
          msgtype: "mixed",
          mixed: { msg_item: [{ msgtype: "text", text: { content: "引用混排" } }] },
        },
      },
      {
        msgid: "j3",
        aibotid: "b1",
        chattype: "single",
        from: { userid: "ju3" },
        response_url: "https://example.com/r3",
        msgtype: "custom_unknown",
      },
      {
        msgid: "j_event",
        aibotid: "b1",
        msgtype: "event",
        event: { eventtype: "enter_chat" },
      },
      {
        msgid: "j_stream_empty",
        aibotid: "b1",
        msgtype: "stream",
        stream: { id: "unknown_s" },
      },
    ];
    for (const payload of jsonMsgs) {
      await receiver.handleWebhook(
        makeWebhookReq({
          method: "POST",
          bodyText: aibotCrypt.encryptReply({
            plaintext: JSON.stringify(payload),
            timestamp: ts,
            nonce,
            format: "json",
          }),
        }),
      );
    }
    const formattedWithQuote = receiver.formatInbound(received[4]!.params, received[4]!.context);
    expect(formattedWithQuote.text).toContain("> 引用语音");

    // Cache limit was 2 -> `msg:j1` evicted when `j2` and `j3` arrived
    expect(receiver.consumeCachedResponseUrl("msg:j1")).toBeUndefined();
    expect(receiver.consumeCachedResponseUrl("msg:j2")).toBe("https://example.com/r2");
    // Advance clock past 1-hour TTL -> `j3` expires
    clockMs += 3_700_000;
    expect(receiver.consumeCachedResponseUrl("msg:j3")).toBeUndefined();
  });
});
