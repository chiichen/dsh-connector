/**
 * Enterprise WeChat (WeCom) inbound `ConnectorReceiver` implementation.
 *
 * Handles:
 * 1. HTTP GET callback URL challenge verification (`msg_signature` + AES-256-CBC `echostr` decryption)
 * 2. HTTP POST encrypted XML callbacks for Self-Built Applications (`app-webhook`)
 * 3. HTTP POST encrypted JSON callbacks for Intelligent Bots (`aibot-webhook`), including:
 *    - Single-use 1-hour `response_url` caching per conversation context
 *    - Optional passive `msgtype: "stream"` refresh polling delegation via `WeComStreamingAdapter`
 * 4. WebSocket `aibot_msg_callback` frame ingestion (`aibot-ws`)
 * 5. Bot self-message anti-loop filtering, optional group `@mention` gating, and DSH context marker extraction
 *
 * @see https://developer.work.weixin.qq.com/document/path/90930 Self-built app callback configuration
 * @see https://developer.work.weixin.qq.com/document/path/90238 Self-built app callback request/response spec
 * @see https://developer.work.weixin.qq.com/document/path/90239 Self-built app ordinary message XML format
 * @see https://developer.work.weixin.qq.com/document/path/100719 Intelligent bot HTTP callback message format
 * @see https://developer.work.weixin.qq.com/document/path/101033 Intelligent bot callback encryption/decryption
 * @see https://developer.work.weixin.qq.com/document/path/101463 Intelligent bot WebSocket callback format
 */

import {
  ConnectorAuthError,
  createConnectorContext,
  extractContextMarker,
  type ConnectorContext,
  type ConnectorContextId,
  type ConnectorInboundPrompt,
  type ConnectorReceiver,
  type ConnectorReceiverContext,
  type ConnectorWebhookRequest,
  type ConnectorWebhookResponse,
} from "@dsh-connector/core";
import {
  CONTENT_TYPE_JSON_UTF8,
  CONTENT_TYPE_TEXT_PLAIN_UTF8,
  DEFAULT_WECOM_CONNECTOR_NAME,
  DEFAULT_WECOM_RESPONSE_URL_CACHE_LIMIT,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_OK,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_UNAUTHORIZED,
  SECONDS_TO_MS,
  WECOM_RESPONSE_URL_TTL_MS,
} from "./constants";
import { formatWeComContextId } from "./context-target";
import { WeComMsgCrypt, extractEncryptedCallbackEnvelope, parseWeComXmlFields } from "./crypto";
import type { WeComStreamingAdapter, WeComStreamRefreshCallbackPayload } from "./streaming";
import { wecomReceiveSchema, type WeComCallbackConfig, type WeComReceiveParams } from "./types";
import type { WeComAibotWsCallbackFrame } from "./ws-client";

const REGEX_META_CHARS_RE = /[.*+?^${}()|[\]\\]/gu;
const SUGGESTED_TITLE_MAX_LEN = 48;

interface CachedResponseUrlEntry {
  readonly url: string;
  readonly expiresAtMs: number;
}

export interface WeComReceiverOptions<TName extends string = "wecom"> {
  readonly connectorName?: TName;
  readonly appCorpId?: string;
  readonly appAgentId?: number | string;
  readonly aibotId?: string;
  readonly callback?: WeComCallbackConfig;
  readonly selfUserIds?: readonly string[];
  readonly botMentionNames?: readonly string[];
  readonly requireMentionInGroup?: boolean;
  readonly inboundDeliveryMode?: "queue" | "steer";
  readonly responseUrlCacheLimit?: number;
  readonly now?: () => number;
  readonly streamingAdapter?: WeComStreamingAdapter;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(literal: string): string {
  return literal.replace(REGEX_META_CHARS_RE, "\\$&");
}

function extractQuoteText(quote: unknown): string | undefined {
  if (!isPlainRecord(quote)) {
    return undefined;
  }
  const textObj = isPlainRecord(quote["text"]) ? quote["text"] : undefined;
  if (typeof textObj?.["content"] === "string" && textObj["content"].trim().length > 0) {
    return textObj["content"];
  }
  const voiceObj = isPlainRecord(quote["voice"]) ? quote["voice"] : undefined;
  if (typeof voiceObj?.["content"] === "string" && voiceObj["content"].trim().length > 0) {
    return voiceObj["content"];
  }
  if (isPlainRecord(quote["mixed"]) && Array.isArray(quote["mixed"]["msg_item"])) {
    const parts: string[] = [];
    for (const item of quote["mixed"]["msg_item"]) {
      if (
        isPlainRecord(item) &&
        isPlainRecord(item["text"]) &&
        typeof item["text"]["content"] === "string"
      ) {
        parts.push(item["text"]["content"]);
      }
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return undefined;
}

function extractAibotMessageContent(body: Readonly<Record<string, unknown>>): {
  readonly msgType: string;
  readonly text: string;
  readonly mediaUrl?: string;
} {
  const msgType = typeof body["msgtype"] === "string" ? body["msgtype"].toLowerCase() : "unknown";

  if (msgType === "text") {
    const textObj = isPlainRecord(body["text"]) ? body["text"] : undefined;
    const content = typeof textObj?.["content"] === "string" ? textObj["content"] : "";
    return { msgType, text: content };
  }

  if (msgType === "voice") {
    const voiceObj = isPlainRecord(body["voice"]) ? body["voice"] : undefined;
    const content = typeof voiceObj?.["content"] === "string" ? voiceObj["content"] : "[voice]";
    return { msgType, text: content };
  }

  if (msgType === "mixed") {
    const mixedObj = isPlainRecord(body["mixed"]) ? body["mixed"] : undefined;
    const items = Array.isArray(mixedObj?.["msg_item"]) ? mixedObj["msg_item"] : [];
    const textParts: string[] = [];
    let firstImageUrl: string | undefined;

    for (const item of items) {
      if (!isPlainRecord(item)) {
        continue;
      }
      if (
        item["msgtype"] === "text" &&
        isPlainRecord(item["text"]) &&
        typeof item["text"]["content"] === "string"
      ) {
        textParts.push(item["text"]["content"]);
      } else if (
        item["msgtype"] === "image" &&
        isPlainRecord(item["image"]) &&
        typeof item["image"]["url"] === "string" &&
        firstImageUrl === undefined
      ) {
        firstImageUrl = item["image"]["url"];
      }
    }

    const joined = textParts.join("\n").trim();
    return {
      msgType,
      text: joined.length > 0 ? joined : "[mixed]",
      ...(firstImageUrl !== undefined ? { mediaUrl: firstImageUrl } : {}),
    };
  }

  if (msgType === "image" || msgType === "file" || msgType === "video") {
    const mediaObj = isPlainRecord(body[msgType]) ? body[msgType] : undefined;
    const url = typeof mediaObj?.["url"] === "string" ? mediaObj["url"] : undefined;
    return {
      msgType,
      text: `[${msgType}]`,
      ...(url !== undefined ? { mediaUrl: url } : {}),
    };
  }

  return { msgType, text: `[${msgType}]` };
}

export class WeComReceiver<TName extends string = "wecom"> implements ConnectorReceiver<
  typeof wecomReceiveSchema,
  TName
> {
  readonly schema = wecomReceiveSchema;
  private readonly connectorName: TName;
  private readonly appCorpId: string | undefined;
  private readonly msgCrypt: WeComMsgCrypt | undefined;
  private readonly explicitReceiveId: string | undefined;
  private readonly selfIds: ReadonlySet<string>;
  private readonly botMentionNames: readonly string[];
  private readonly requireMentionInGroup: boolean;
  private readonly inboundDeliveryMode: "queue" | "steer" | undefined;
  private readonly responseUrlCacheLimit: number;
  private readonly now: () => number;
  private readonly streamingAdapter: WeComStreamingAdapter | undefined;

  private receiverCtx: ConnectorReceiverContext<typeof wecomReceiveSchema, TName> | undefined;
  private readonly responseUrlCache = new Map<string, CachedResponseUrlEntry>();

  constructor(options: WeComReceiverOptions<TName> = {}) {
    this.connectorName = (options.connectorName ?? DEFAULT_WECOM_CONNECTOR_NAME) as TName;
    this.appCorpId = options.appCorpId?.trim();
    this.explicitReceiveId = options.callback?.receiveId;
    this.msgCrypt =
      options.callback !== undefined
        ? new WeComMsgCrypt({
            token: options.callback.token,
            encodingAesKey: options.callback.encodingAesKey,
            ...(options.callback.receiveId !== undefined
              ? { receiveId: options.callback.receiveId }
              : {}),
          })
        : undefined;

    const ids = new Set<string>();
    for (const id of options.selfUserIds ?? []) {
      const trimmed = id.trim();
      if (trimmed.length > 0) {
        ids.add(trimmed);
      }
    }
    if (this.appCorpId !== undefined && this.appCorpId.length > 0) {
      ids.add(this.appCorpId);
    }
    if (options.appAgentId !== undefined) {
      ids.add(String(options.appAgentId).trim());
    }
    if (options.aibotId !== undefined && options.aibotId.trim().length > 0) {
      ids.add(options.aibotId.trim());
    }
    this.selfIds = ids;

    this.botMentionNames = (options.botMentionNames ?? [])
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    this.requireMentionInGroup = options.requireMentionInGroup ?? false;
    this.inboundDeliveryMode = options.inboundDeliveryMode;
    this.responseUrlCacheLimit =
      options.responseUrlCacheLimit ?? DEFAULT_WECOM_RESPONSE_URL_CACHE_LIMIT;
    this.now = options.now ?? Date.now;
    this.streamingAdapter = options.streamingAdapter;
  }

  init(ctx: ConnectorReceiverContext<typeof wecomReceiveSchema, TName>): void {
    this.receiverCtx = ctx;
  }

  formatInbound(
    params: WeComReceiveParams,
    context: ConnectorContext<TName>,
  ): ConnectorInboundPrompt {
    const headerParts = [
      `[WeCom ${params.source}]`,
      `from=${params.senderId}`,
      params.chatType === "group" && params.chatId !== undefined
        ? `group=${params.chatId}`
        : "chat=single",
      `context=${context.contextId}`,
    ];

    const lines: string[] = [headerParts.join(" ")];
    if (params.quotedText !== undefined && params.quotedText.trim().length > 0) {
      const quotedLines = params.quotedText
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      lines.push(quotedLines);
    }
    lines.push(params.text);
    if (params.mediaUrl !== undefined) {
      lines.push(`[media_url: ${params.mediaUrl}]`);
    } else if (params.mediaId !== undefined) {
      lines.push(`[media_id: ${params.mediaId}]`);
    }

    const preview = params.text.trim().slice(0, SUGGESTED_TITLE_MAX_LEN);
    return {
      text: lines.join("\n"),
      title:
        params.chatType === "group" && params.chatId !== undefined
          ? `WeCom Group ${params.chatId}: ${preview}`
          : `WeCom ${params.senderId}: ${preview}`,
    };
  }

  consumeCachedResponseUrl(contextId: string): string | undefined {
    this.pruneExpiredResponseUrls();
    const entry = this.responseUrlCache.get(contextId);
    if (entry === undefined) {
      return undefined;
    }
    this.responseUrlCache.delete(contextId);
    return entry.url;
  }

  async handleWebhook(req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse> {
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "POST") {
      return {
        status: HTTP_STATUS_METHOD_NOT_ALLOWED,
        headers: {
          "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8,
          allow: "GET, POST",
        },
        body: "Method Not Allowed",
      };
    }

    if (this.msgCrypt === undefined) {
      return {
        status: HTTP_STATUS_SERVICE_UNAVAILABLE,
        headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8 },
        body: "WeCom callback cryptography is not configured.",
      };
    }

    if (method === "GET") {
      return this.handleGetVerifyUrl(req.query, this.msgCrypt);
    }

    return this.handlePostCallback(req, this.msgCrypt);
  }

  /**
   * Ingests an Intelligent Bot WebSocket `aibot_msg_callback` frame into DSH `onReceive`.
   *
   * @see https://developer.work.weixin.qq.com/document/path/101463
   */
  async ingestWsMessageCallback(frame: WeComAibotWsCallbackFrame): Promise<void> {
    const body = frame.body;
    const msgType = typeof body["msgtype"] === "string" ? body["msgtype"].toLowerCase() : "";
    if (msgType === "event" || msgType === "stream" || msgType.length === 0) {
      return;
    }

    const fromObj = isPlainRecord(body["from"]) ? body["from"] : undefined;
    const senderId = typeof fromObj?.["userid"] === "string" ? fromObj["userid"].trim() : "";
    const botId = typeof body["aibotid"] === "string" ? body["aibotid"].trim() : undefined;
    if (senderId.length === 0 || this.isSelfSender(senderId, botId)) {
      return;
    }

    const chatType: "single" | "group" = body["chattype"] === "group" ? "group" : "single";
    const chatId =
      typeof body["chatid"] === "string" && body["chatid"].trim().length > 0
        ? body["chatid"].trim()
        : undefined;

    const extracted = extractAibotMessageContent(body);
    const mentionChecked = this.applyGroupMentionPolicy(extracted.text, chatType);
    if (!mentionChecked.accepted) {
      return;
    }

    const rawQuotedText = extractQuoteText(body["quote"]);
    const messageId =
      typeof body["msgid"] === "string" && body["msgid"].trim().length > 0
        ? body["msgid"].trim()
        : `${senderId}:${this.now()}`;

    await this.dispatchInbound({
      source: "aibot-ws",
      defaultChannel: "aibot",
      messageId,
      msgType: extracted.msgType,
      senderId,
      chatType,
      chatId,
      botId,
      rawText: mentionChecked.cleanedText,
      rawQuotedText,
      mediaUrl: extracted.mediaUrl,
      reqId: frame.headers.req_id.length > 0 ? frame.headers.req_id : undefined,
    });
  }

  private handleGetVerifyUrl(
    query: URLSearchParams,
    msgCrypt: WeComMsgCrypt,
  ): ConnectorWebhookResponse {
    const msgSignature = query.get("msg_signature") ?? query.get("msgsignature") ?? "";
    const timestamp = query.get("timestamp") ?? "";
    const nonce = query.get("nonce") ?? "";
    const echostr = query.get("echostr") ?? "";

    if (
      msgSignature.length === 0 ||
      timestamp.length === 0 ||
      nonce.length === 0 ||
      echostr.length === 0
    ) {
      return {
        status: HTTP_STATUS_BAD_REQUEST,
        headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8 },
        body: "Missing required WeCom URL verification query parameters.",
      };
    }

    try {
      const verified = msgCrypt.verifyUrl({
        msgSignature,
        timestamp,
        nonce,
        echostr,
        ...(this.explicitReceiveId !== undefined
          ? { expectedReceiveId: this.explicitReceiveId }
          : {}),
      });

      if (
        this.explicitReceiveId === undefined &&
        this.appCorpId !== undefined &&
        verified.receiveId !== this.appCorpId &&
        verified.receiveId !== ""
      ) {
        throw new ConnectorAuthError("WeCom URL verification receiveId mismatch.");
      }

      return {
        status: HTTP_STATUS_OK,
        headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8 },
        body: verified.message,
      };
    } catch {
      return {
        status: HTTP_STATUS_UNAUTHORIZED,
        headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8 },
        body: "WeCom URL verification failed.",
      };
    }
  }

  private async handlePostCallback(
    req: ConnectorWebhookRequest,
    msgCrypt: WeComMsgCrypt,
  ): Promise<ConnectorWebhookResponse> {
    const rawBodyText = new TextDecoder().decode(req.rawBody);
    const envelope = extractEncryptedCallbackEnvelope(rawBodyText);
    if (envelope === undefined) {
      return {
        status: HTTP_STATUS_BAD_REQUEST,
        headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8 },
        body: "Invalid or missing WeCom encrypted callback payload.",
      };
    }

    const msgSignature =
      envelope.msgSignature ??
      req.query.get("msg_signature") ??
      req.query.get("msgsignature") ??
      "";
    const timestamp = envelope.timestamp ?? req.query.get("timestamp") ?? "";
    const nonce = envelope.nonce ?? req.query.get("nonce") ?? "";

    if (msgSignature.length === 0 || timestamp.length === 0 || nonce.length === 0) {
      return {
        status: HTTP_STATUS_BAD_REQUEST,
        headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8 },
        body: "Missing WeCom callback signature parameters.",
      };
    }

    const expectedReceiveId =
      this.explicitReceiveId !== undefined
        ? this.explicitReceiveId
        : envelope.format === "xml"
          ? this.appCorpId
          : "";

    let decryptedMessage: string;
    try {
      const result = msgCrypt.decryptCallback({
        msgSignature,
        timestamp,
        nonce,
        encrypt: envelope.encrypt,
        ...(expectedReceiveId !== undefined ? { expectedReceiveId } : {}),
      });
      decryptedMessage = result.message;
    } catch {
      return {
        status: HTTP_STATUS_UNAUTHORIZED,
        headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8 },
        body: "WeCom callback signature or decryption failed.",
      };
    }

    if (envelope.format === "xml") {
      await this.processDecryptedXmlAppMessage(decryptedMessage);
      return {
        status: HTTP_STATUS_OK,
        headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8 },
        body: "",
      };
    }

    return this.processDecryptedJsonAibotMessage(decryptedMessage, {
      msgCrypt,
      timestamp,
      nonce,
    });
  }

  private async processDecryptedXmlAppMessage(xmlText: string): Promise<void> {
    const xml = parseWeComXmlFields(xmlText);
    const msgType = (xml["MsgType"] ?? "").trim().toLowerCase();
    if (msgType.length === 0 || msgType === "event" || msgType === "stream") {
      return;
    }

    const senderId = (xml["FromUserName"] ?? "").trim();
    const toUserName = (xml["ToUserName"] ?? "").trim();
    if (senderId.length === 0 || this.isSelfSender(senderId, toUserName)) {
      return;
    }

    const chatId = xml["ChatId"]?.trim() || undefined;
    const chatType: "single" | "group" = chatId !== undefined ? "group" : "single";
    const rawContent =
      msgType === "text"
        ? (xml["Content"] ?? "")
        : msgType === "voice" && xml["Recognition"] !== undefined
          ? xml["Recognition"]
          : msgType === "location" && xml["Label"] !== undefined
            ? `[location] ${xml["Label"]}`
            : msgType === "link" && xml["Title"] !== undefined
              ? `[link] ${xml["Title"]}${xml["Url"] !== undefined ? ` (${xml["Url"]})` : ""}`
              : `[${msgType}]`;

    const mentionChecked = this.applyGroupMentionPolicy(rawContent, chatType);
    if (!mentionChecked.accepted) {
      return;
    }

    const createTimeSec = Number.parseInt(xml["CreateTime"] ?? "", 10);
    const createdAt = Number.isFinite(createTimeSec) ? createTimeSec * SECONDS_TO_MS : undefined;
    const messageId =
      xml["MsgId"]?.trim() || `${senderId}:${xml["CreateTime"]?.trim() ?? this.now()}`;

    await this.dispatchInbound({
      source: "app-webhook",
      defaultChannel: "app",
      messageId,
      msgType,
      senderId,
      chatType,
      chatId,
      agentId: xml["AgentID"]?.trim() || undefined,
      rawText: mentionChecked.cleanedText,
      mediaUrl: xml["PicUrl"]?.trim() || undefined,
      mediaId: xml["MediaId"]?.trim() || undefined,
      createdAt,
    });
  }

  private async processDecryptedJsonAibotMessage(
    jsonText: string,
    replyContext: {
      readonly msgCrypt: WeComMsgCrypt;
      readonly timestamp: string;
      readonly nonce: string;
    },
  ): Promise<ConnectorWebhookResponse> {
    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(jsonText);
    } catch {
      return {
        status: HTTP_STATUS_BAD_REQUEST,
        headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8 },
        body: "Invalid decrypted WeCom JSON message.",
      };
    }

    if (!isPlainRecord(parsedUnknown)) {
      return {
        status: HTTP_STATUS_BAD_REQUEST,
        headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8 },
        body: "Invalid decrypted WeCom JSON object.",
      };
    }

    const msgType =
      typeof parsedUnknown["msgtype"] === "string" ? parsedUnknown["msgtype"].toLowerCase() : "";

    if (msgType === "stream") {
      return this.handlePassiveStreamRefresh(parsedUnknown, replyContext);
    }

    if (msgType.length === 0 || msgType === "event") {
      return {
        status: HTTP_STATUS_OK,
        headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8 },
        body: "",
      };
    }

    const fromObj = isPlainRecord(parsedUnknown["from"]) ? parsedUnknown["from"] : undefined;
    const senderId = typeof fromObj?.["userid"] === "string" ? fromObj["userid"].trim() : "";
    const botId =
      typeof parsedUnknown["aibotid"] === "string" ? parsedUnknown["aibotid"].trim() : undefined;
    if (senderId.length === 0 || this.isSelfSender(senderId, botId)) {
      return {
        status: HTTP_STATUS_OK,
        headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8 },
        body: "",
      };
    }

    const chatType: "single" | "group" = parsedUnknown["chattype"] === "group" ? "group" : "single";
    const chatId =
      typeof parsedUnknown["chatid"] === "string" && parsedUnknown["chatid"].trim().length > 0
        ? parsedUnknown["chatid"].trim()
        : undefined;
    const extracted = extractAibotMessageContent(parsedUnknown);
    const mentionChecked = this.applyGroupMentionPolicy(extracted.text, chatType);
    if (!mentionChecked.accepted) {
      return {
        status: HTTP_STATUS_OK,
        headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8 },
        body: "",
      };
    }

    const rawQuotedText = extractQuoteText(parsedUnknown["quote"]);
    const responseUrl =
      typeof parsedUnknown["response_url"] === "string" &&
      parsedUnknown["response_url"].trim().length > 0
        ? parsedUnknown["response_url"].trim()
        : undefined;
    const messageId =
      typeof parsedUnknown["msgid"] === "string" && parsedUnknown["msgid"].trim().length > 0
        ? parsedUnknown["msgid"].trim()
        : `${senderId}:${this.now()}`;

    await this.dispatchInbound({
      source: "aibot-webhook",
      defaultChannel: "aibot",
      messageId,
      msgType: extracted.msgType,
      senderId,
      chatType,
      chatId,
      botId,
      rawText: mentionChecked.cleanedText,
      rawQuotedText,
      mediaUrl: extracted.mediaUrl,
      responseUrl,
    });

    return {
      status: HTTP_STATUS_OK,
      headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8 },
      body: "",
    };
  }

  private async handlePassiveStreamRefresh(
    payload: Record<string, unknown>,
    replyContext: {
      readonly msgCrypt: WeComMsgCrypt;
      readonly timestamp: string;
      readonly nonce: string;
    },
  ): Promise<ConnectorWebhookResponse> {
    const streamObj = isPlainRecord(payload["stream"]) ? payload["stream"] : undefined;
    const streamId = typeof streamObj?.["id"] === "string" ? streamObj["id"] : "";
    if (streamId.length > 0 && this.streamingAdapter?.getPassiveStreamSnapshot !== undefined) {
      const fromObj = isPlainRecord(payload["from"]) ? payload["from"] : undefined;
      const refreshPayload: WeComStreamRefreshCallbackPayload = {
        msgid: typeof payload["msgid"] === "string" ? payload["msgid"] : "",
        aibotid: typeof payload["aibotid"] === "string" ? payload["aibotid"] : "",
        ...(typeof payload["chatid"] === "string" ? { chatid: payload["chatid"] } : {}),
        chattype: payload["chattype"] === "group" ? "group" : "single",
        from: {
          userid: typeof fromObj?.["userid"] === "string" ? fromObj["userid"] : "",
        },
        msgtype: "stream",
        stream: { id: streamId },
      };

      const snapshot = await this.streamingAdapter.getPassiveStreamSnapshot(
        streamId,
        refreshPayload,
      );
      if (snapshot !== undefined) {
        const encryptedBody = replyContext.msgCrypt.encryptReply({
          plaintext: JSON.stringify(snapshot),
          timestamp: replyContext.timestamp,
          nonce: replyContext.nonce,
          format: "json",
          receiveId: "",
        });
        return {
          status: HTTP_STATUS_OK,
          headers: { "content-type": CONTENT_TYPE_JSON_UTF8 },
          body: encryptedBody,
        };
      }
    }

    return {
      status: HTTP_STATUS_OK,
      headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8 },
      body: "",
    };
  }

  private isSelfSender(senderId: string, dynamicBotId?: string): boolean {
    if (this.selfIds.has(senderId)) {
      return true;
    }
    if (dynamicBotId !== undefined && dynamicBotId.length > 0 && senderId === dynamicBotId) {
      return true;
    }
    return false;
  }

  private applyGroupMentionPolicy(
    rawText: string,
    chatType: "single" | "group",
  ): { readonly accepted: boolean; readonly cleanedText: string } {
    if (chatType !== "group" || this.botMentionNames.length === 0) {
      return {
        accepted: !(
          chatType === "group" &&
          this.requireMentionInGroup &&
          this.botMentionNames.length === 0 &&
          !rawText.includes("@")
        ),
        cleanedText: rawText,
      };
    }

    let matched = false;
    let cleaned = rawText;
    for (const botName of this.botMentionNames) {
      const mentionRe = new RegExp(`@${escapeRegExp(botName)}\\s*`, "iu");
      if (mentionRe.test(cleaned)) {
        matched = true;
        cleaned = cleaned.replace(mentionRe, "").trim();
      }
    }

    if (!matched && this.requireMentionInGroup) {
      return { accepted: false, cleanedText: rawText };
    }

    return { accepted: true, cleanedText: cleaned.length > 0 ? cleaned : rawText };
  }

  private async dispatchInbound(input: {
    readonly source: "app-webhook" | "aibot-webhook" | "aibot-ws";
    readonly defaultChannel: "app" | "aibot";
    readonly messageId: string;
    readonly msgType: string;
    readonly senderId: string;
    readonly chatType: "single" | "group";
    readonly chatId?: string;
    readonly botId?: string;
    readonly agentId?: string;
    readonly rawText: string;
    readonly rawQuotedText?: string;
    readonly mediaUrl?: string;
    readonly mediaId?: string;
    readonly responseUrl?: string;
    readonly reqId?: string;
    readonly createdAt?: number;
  }): Promise<void> {
    if (this.receiverCtx === undefined) {
      return;
    }

    const extractedText = extractContextMarker(input.rawText);
    const extractedQuote =
      input.rawQuotedText !== undefined ? extractContextMarker(input.rawQuotedText) : undefined;

    const fallbackContextId = formatWeComContextId({
      channel: input.defaultChannel,
      peerKind: input.chatType === "group" && input.chatId !== undefined ? "group" : "p2p",
      targetId:
        input.chatType === "group" && input.chatId !== undefined ? input.chatId : input.senderId,
    });

    const resolvedContextId: ConnectorContextId =
      extractedQuote?.contextId ?? extractedText.contextId ?? fallbackContextId;

    if (input.responseUrl !== undefined) {
      this.cacheResponseUrl(resolvedContextId, input.responseUrl);
    }

    const context = createConnectorContext(this.connectorName, resolvedContextId);
    const cleanedPrimaryText = extractedText.cleanedContent.trim();
    const cleanedQuoteText = extractedQuote?.cleanedContent.trim();

    const params: WeComReceiveParams = {
      source: input.source,
      messageId: input.messageId,
      msgType: input.msgType,
      senderId: input.senderId,
      chatType: input.chatType,
      text: cleanedPrimaryText.length > 0 ? cleanedPrimaryText : input.rawText,
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
      ...(input.botId !== undefined ? { botId: input.botId } : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(cleanedQuoteText !== undefined && cleanedQuoteText.length > 0
        ? { quotedText: cleanedQuoteText }
        : {}),
      ...(input.mediaUrl !== undefined ? { mediaUrl: input.mediaUrl } : {}),
      ...(input.mediaId !== undefined ? { mediaId: input.mediaId } : {}),
      ...(input.responseUrl !== undefined ? { responseUrl: input.responseUrl } : {}),
      ...(input.reqId !== undefined ? { reqId: input.reqId } : {}),
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    };

    const preview = params.text.slice(0, SUGGESTED_TITLE_MAX_LEN);
    await this.receiverCtx.onReceive(context, params, {
      idempotencyKey: input.messageId,
      suggestedTitle:
        input.chatType === "group" && input.chatId !== undefined
          ? `WeCom Group ${input.chatId}: ${preview}`
          : `WeCom ${input.senderId}: ${preview}`,
      receivedAt: input.createdAt ?? this.now(),
      ...(this.inboundDeliveryMode !== undefined ? { deliveryMode: this.inboundDeliveryMode } : {}),
    });
  }

  private cacheResponseUrl(contextId: string, url: string): void {
    this.pruneExpiredResponseUrls();
    if (
      !this.responseUrlCache.has(contextId) &&
      this.responseUrlCache.size >= this.responseUrlCacheLimit
    ) {
      const oldestKey = this.responseUrlCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.responseUrlCache.delete(oldestKey);
      }
    }
    this.responseUrlCache.set(contextId, {
      url,
      expiresAtMs: this.now() + WECOM_RESPONSE_URL_TTL_MS,
    });
  }

  private pruneExpiredResponseUrls(): void {
    const currentMs = this.now();
    for (const [key, entry] of this.responseUrlCache.entries()) {
      if (entry.expiresAtMs <= currentMs) {
        this.responseUrlCache.delete(key);
      }
    }
  }
}
