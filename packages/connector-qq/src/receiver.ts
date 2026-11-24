import {
  createConnectorContext,
  extractContextMarker,
  type ConnectorContext,
  type ConnectorInboundPrompt,
  type ConnectorLogger,
  type ConnectorReceiverContext,
  type ConnectorWebhookRequest,
  type ConnectorWebhookResponse,
} from "@dsh-connector/core";
import { formatQqContextId } from "./addressing";
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_OK,
  HTTP_STATUS_UNAUTHORIZED,
  QQ_EVENT_AT_MESSAGE_CREATE,
  QQ_EVENT_C2C_MESSAGE_CREATE,
  QQ_EVENT_GROUP_AT_MESSAGE_CREATE,
  QQ_HEADER_BOT_APPID,
  QQ_HEADER_SIGNATURE_ED25519,
  QQ_HEADER_SIGNATURE_TIMESTAMP,
  QQ_INBOUND_MESSAGE_TYPE_QUOTE,
  QQ_OPCODE_CALLBACK_VALIDATION,
  QQ_OPCODE_DISPATCH,
  QQ_OPCODE_HTTP_CALLBACK_ACK,
} from "./constants";
import type { QqPassiveReplyTracker } from "./sender";
import { signQqCallbackValidation, verifyQqWebhookSignature } from "./signature";
import type {
  QqInboundAttachmentMeta,
  QqInboundEventType,
  QqInboundMessage,
  QqTarget,
} from "./types";
import { qqReceiveSchema } from "./types";

export interface QqRawGatewayEnvelope {
  readonly id?: unknown;
  readonly op?: unknown;
  readonly s?: unknown;
  readonly t?: unknown;
  readonly d?: unknown;
}

interface QqRawAuthor {
  readonly id?: unknown;
  readonly username?: unknown;
  readonly bot?: unknown;
  readonly user_openid?: unknown;
  readonly member_openid?: unknown;
  readonly member_nickname?: unknown;
}

interface QqRawMsgElement {
  readonly msg_idx?: unknown;
  readonly message_type?: unknown;
  readonly content?: unknown;
  readonly msg_elements?: unknown;
}

interface QqRawAttachment {
  readonly url?: unknown;
  readonly filename?: unknown;
  readonly content_type?: unknown;
  readonly size?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
}

interface QqRawMessageEventData {
  readonly id?: unknown;
  readonly content?: unknown;
  readonly timestamp?: unknown;
  readonly group_openid?: unknown;
  readonly guild_id?: unknown;
  readonly channel_id?: unknown;
  readonly author?: QqRawAuthor;
  readonly mentions?: ReadonlyArray<{
    readonly id?: unknown;
    readonly member_openid?: unknown;
    readonly is_you?: unknown;
  }>;
  readonly message_scene?: {
    readonly ext?: readonly unknown[];
  };
  readonly msg_elements?: readonly QqRawMsgElement[];
  readonly attachments?: readonly QqRawAttachment[];
}

function readHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  lowerName: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) {
      continue;
    }
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value) && typeof value[0] === "string") {
      return value[0];
    }
  }
  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractSceneExtMap(ext: readonly unknown[] | undefined): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  if (!Array.isArray(ext)) {
    return result;
  }
  for (const item of ext) {
    if (typeof item !== "string") {
      continue;
    }
    const eqIdx = item.indexOf("=");
    if (eqIdx <= 0) {
      continue;
    }
    const k = item.slice(0, eqIdx).trim();
    const v = item.slice(eqIdx + 1).trim();
    if (k.length > 0 && v.length > 0) {
      result.set(k, v);
    }
  }
  return result;
}

function extractQuotedTextFromElements(
  elements: readonly QqRawMsgElement[] | undefined,
): string | undefined {
  if (!Array.isArray(elements)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const el of elements) {
    if (!isPlainObject(el)) {
      continue;
    }
    if (el.message_type === QQ_INBOUND_MESSAGE_TYPE_QUOTE && typeof el.content === "string") {
      parts.push(el.content);
    }
    if (Array.isArray(el.msg_elements)) {
      const nested = extractQuotedTextFromElements(el.msg_elements as readonly QqRawMsgElement[]);
      if (nested !== undefined) {
        parts.push(nested);
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function parseAttachments(
  raw: readonly QqRawAttachment[] | undefined,
): QqInboundAttachmentMeta[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const list: QqInboundAttachmentMeta[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) {
      continue;
    }
    const entry: QqInboundAttachmentMeta = {
      ...(typeof item.url === "string" ? { url: item.url } : {}),
      ...(typeof item.filename === "string" ? { filename: item.filename } : {}),
      ...(typeof item.content_type === "string" ? { contentType: item.content_type } : {}),
      ...(typeof item.size === "number" && Number.isInteger(item.size) && item.size >= 0
        ? { size: item.size }
        : {}),
      ...(typeof item.width === "number" && Number.isInteger(item.width) && item.width > 0
        ? { width: item.width }
        : {}),
      ...(typeof item.height === "number" && Number.isInteger(item.height) && item.height > 0
        ? { height: item.height }
        : {}),
    };
    list.push(entry);
  }
  return list.length > 0 ? list : undefined;
}

function stripBotMentions(content: string, botIds: ReadonlySet<string>): string {
  return content
    .replace(/<@!?([^<>\s]+)>[ \t]*/gu, (fullMatch, id: string) =>
      botIds.has(id) ? "" : fullMatch,
    )
    .trim();
}

function jsonWebhookResponse(status: number, payload: unknown): ConnectorWebhookResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

export interface QqEventReceiverOptions<TName extends string = string> {
  readonly connectorName: TName;
  readonly appId: string;
  readonly clientSecret: string;
  readonly logger?: ConnectorLogger;
  readonly botUserId?: string;
  readonly passiveTracker: QqPassiveReplyTracker;
  readonly now?: () => number;
}

/**
 * Unified QQ Bot inbound event processor for both HTTP Webhook (`OpCode 13` + Ed25519 `OpCode 0`)
 * and WebSocket Gateway (`C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` / `AT_MESSAGE_CREATE`).
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/event.html
 */
export class QqEventReceiver<TName extends string = string> {
  readonly schema = qqReceiveSchema;

  private readonly connectorName: TName;
  private readonly appId: string;
  private readonly clientSecret: string;
  private readonly botIds = new Set<string>();
  private readonly passiveTracker: QqPassiveReplyTracker;
  private readonly now: () => number;
  private runtimeCtx: ConnectorReceiverContext<typeof qqReceiveSchema, TName> | undefined;
  private readonly hostLogger: ConnectorLogger | undefined;

  constructor(options: QqEventReceiverOptions<TName>) {
    this.connectorName = options.connectorName;
    this.hostLogger = options.logger;
    this.appId = options.appId.trim();
    this.clientSecret = options.clientSecret.trim();
    this.passiveTracker = options.passiveTracker;
    this.now = options.now ?? Date.now;

    this.botIds.add(this.appId);
    const botUserId = asNonEmptyString(options.botUserId);
    if (botUserId !== undefined) {
      this.botIds.add(botUserId);
    }
  }

  init(ctx: ConnectorReceiverContext<typeof qqReceiveSchema, TName>): void {
    this.runtimeCtx = ctx;
  }

  getLogger(): ConnectorReceiverContext<typeof qqReceiveSchema, TName>["logger"] | undefined {
    return this.runtimeCtx?.logger ?? this.hostLogger;
  }

  /**
   * Registers the bot's runtime user ID (e.g. discovered from WebSocket `READY` event)
   * for self-message loop prevention and `<@!botId>` mention stripping.
   */
  registerBotUserId(botUserId: string): void {
    const trimmed = asNonEmptyString(botUserId);
    if (trimmed !== undefined) {
      this.botIds.add(trimmed);
    }
  }

  formatInbound(
    params: QqInboundMessage,
    _context: ConnectorContext<TName>,
  ): ConnectorInboundPrompt {
    const senderLabel = params.senderName ?? params.senderId;
    const title =
      params.scene === "c2c"
        ? `QQ C2C ${senderLabel}`
        : params.scene === "group"
          ? `QQ Group ${params.groupOpenId ?? ""}`.trim()
          : `QQ Channel ${params.channelId ?? ""}`.trim();

    const quotePrefix =
      params.quotedContent !== undefined && params.quotedContent.length > 0
        ? `> ${params.quotedContent.split("\n").join("\n> ")}\n\n`
        : "";

    const body =
      params.scene === "c2c"
        ? `${quotePrefix}${params.text}`
        : `[QQ ${params.scene} @${senderLabel}]\n${quotePrefix}${params.text}`;

    return {
      title,
      text: body,
    };
  }

  /**
   * Handles incoming HTTP Webhook requests from QQ Bot Open Platform:
   * - `OpCode 13`: signs `event_ts + plain_token` with secret-derived Ed25519 key and returns `200`.
   * - `OpCode 0`: verifies `X-Signature-Ed25519` + `X-Signature-Timestamp` over raw bytes,
   *   dispatches supported message events, and returns `OpCode 12` (`{"op":12,"d":0}`).
   *
   * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html
   * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
   */
  async handleWebhook(req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse> {
    if (req.method.toUpperCase() !== "POST") {
      return jsonWebhookResponse(HTTP_STATUS_METHOD_NOT_ALLOWED, {
        error: "Method Not Allowed",
      });
    }

    const headerAppId = readHeader(req.headers, QQ_HEADER_BOT_APPID);
    if (headerAppId !== undefined && headerAppId.trim() !== this.appId) {
      return jsonWebhookResponse(HTTP_STATUS_UNAUTHORIZED, {
        error: "Mismatched X-Bot-Appid",
      });
    }

    const rawText = new TextDecoder().decode(req.rawBody);
    let envelope: QqRawGatewayEnvelope;
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (!isPlainObject(parsed)) {
        return jsonWebhookResponse(HTTP_STATUS_BAD_REQUEST, {
          error: "Expected JSON object payload",
        });
      }
      envelope = parsed as QqRawGatewayEnvelope;
    } catch {
      return jsonWebhookResponse(HTTP_STATUS_BAD_REQUEST, {
        error: "Malformed JSON body",
      });
    }

    const sigHeader = readHeader(req.headers, QQ_HEADER_SIGNATURE_ED25519);
    const tsHeader = readHeader(req.headers, QQ_HEADER_SIGNATURE_TIMESTAMP);

    if (envelope.op === QQ_OPCODE_CALLBACK_VALIDATION) {
      if (sigHeader !== undefined) {
        if (
          tsHeader === undefined ||
          !verifyQqWebhookSignature(this.clientSecret, tsHeader, req.rawBody, sigHeader)
        ) {
          return jsonWebhookResponse(HTTP_STATUS_UNAUTHORIZED, {
            error: "Invalid Ed25519 signature on callback validation",
          });
        }
      }

      const d = isPlainObject(envelope.d) ? envelope.d : undefined;
      const plainToken = asNonEmptyString(d?.["plain_token"]);
      const eventTs = asNonEmptyString(d?.["event_ts"]);
      if (plainToken === undefined || eventTs === undefined) {
        return jsonWebhookResponse(HTTP_STATUS_BAD_REQUEST, {
          error: "Missing plain_token or event_ts in OpCode 13 payload",
        });
      }

      const signature = signQqCallbackValidation(this.clientSecret, eventTs, plainToken);
      return jsonWebhookResponse(HTTP_STATUS_OK, {
        plain_token: plainToken,
        signature,
      });
    }

    if (
      sigHeader === undefined ||
      tsHeader === undefined ||
      !verifyQqWebhookSignature(this.clientSecret, tsHeader, req.rawBody, sigHeader)
    ) {
      return jsonWebhookResponse(HTTP_STATUS_UNAUTHORIZED, {
        error: "Invalid or missing Ed25519 webhook signature",
      });
    }

    if (envelope.op === QQ_OPCODE_DISPATCH) {
      await this.dispatchEnvelope(envelope);
    }

    return jsonWebhookResponse(HTTP_STATUS_OK, {
      op: QQ_OPCODE_HTTP_CALLBACK_ACK,
      d: 0,
    });
  }

  /**
   * Processes a verified `OpCode 0` Dispatch envelope from either Webhook or WebSocket Gateway.
   */
  async dispatchEnvelope(envelope: QqRawGatewayEnvelope): Promise<boolean> {
    if (this.runtimeCtx === undefined) {
      return false;
    }

    const eventType = envelope.t;
    if (
      eventType !== QQ_EVENT_C2C_MESSAGE_CREATE &&
      eventType !== QQ_EVENT_GROUP_AT_MESSAGE_CREATE &&
      eventType !== QQ_EVENT_AT_MESSAGE_CREATE
    ) {
      return false;
    }

    if (!isPlainObject(envelope.d)) {
      return false;
    }

    const data = envelope.d as QqRawMessageEventData;
    const author = isPlainObject(data.author) ? (data.author as QqRawAuthor) : undefined;

    // Collect self-mentions marked with is_you=true before filtering/sanitizing
    if (Array.isArray(data.mentions)) {
      for (const mention of data.mentions) {
        if (isPlainObject(mention) && mention.is_you === true) {
          const mId = asNonEmptyString(mention.id);
          const mMemberId = asNonEmptyString(mention.member_openid);
          if (mId !== undefined) this.botIds.add(mId);
          if (mMemberId !== undefined) this.botIds.add(mMemberId);
        }
      }
    }

    const authorId =
      asNonEmptyString(author?.user_openid) ??
      asNonEmptyString(author?.member_openid) ??
      asNonEmptyString(author?.id);

    // Anti-loop: ignore messages authored by bots or matching this bot's own IDs
    if (author?.bot === true || (authorId !== undefined && this.botIds.has(authorId))) {
      return false;
    }

    const messageId = asNonEmptyString(data.id);
    if (messageId === undefined || authorId === undefined) {
      return false;
    }

    const resolvedTarget = this.resolveTargetFromEvent(eventType, data, authorId);
    if (resolvedTarget === undefined) {
      return false;
    }

    const nowMs = this.now();
    this.passiveTracker.recordInbound(resolvedTarget, messageId, nowMs);

    const rawContent = typeof data.content === "string" ? data.content : "";
    const strippedContent = stripBotMentions(rawContent, this.botIds);
    const { contextId: bodyMarkerId, cleanedContent } = extractContextMarker(strippedContent);

    const rawQuoted = extractQuotedTextFromElements(data.msg_elements);
    const quotedExtraction = rawQuoted !== undefined ? extractContextMarker(rawQuoted) : undefined;

    // Context priority: quoted parent marker > current message marker > deterministic business target ID
    const resolvedContextId =
      quotedExtraction?.contextId ?? bodyMarkerId ?? formatQqContextId(resolvedTarget);
    const context = createConnectorContext(this.connectorName, resolvedContextId);

    const extMap = extractSceneExtMap(data.message_scene?.ext);
    const msgIdx = extMap.get("msg_idx");
    const refMsgIdx = extMap.get("ref_msg_idx");
    const outerEventId = asNonEmptyString(envelope.id);
    const idempotencyKey =
      msgIdx !== undefined ? `${messageId}:${msgIdx}` : (outerEventId ?? messageId);

    const senderName =
      asNonEmptyString(author?.member_nickname) ?? asNonEmptyString(author?.username);
    const attachments = parseAttachments(data.attachments);
    const timestamp = asNonEmptyString(data.timestamp);

    const normalized: QqInboundMessage = {
      eventType,
      scene: resolvedTarget.scene,
      messageId,
      ...(outerEventId !== undefined ? { eventId: outerEventId } : {}),
      text: cleanedContent.trim(),
      rawContent,
      ...(quotedExtraction !== undefined && quotedExtraction.cleanedContent.trim().length > 0
        ? { quotedContent: quotedExtraction.cleanedContent.trim() }
        : {}),
      senderId: authorId,
      ...(senderName !== undefined ? { senderName } : {}),
      ...(resolvedTarget.scene === "c2c" ? { openId: resolvedTarget.openId } : {}),
      ...(resolvedTarget.scene === "group" ? { groupOpenId: resolvedTarget.groupOpenId } : {}),
      ...(resolvedTarget.scene === "channel"
        ? {
            channelId: resolvedTarget.channelId,
            ...(resolvedTarget.guildId !== undefined ? { guildId: resolvedTarget.guildId } : {}),
          }
        : {}),
      ...(msgIdx !== undefined ? { msgIdx } : {}),
      ...(refMsgIdx !== undefined ? { refMsgIdx } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
    };

    const suggestedTitle = this.formatInbound(normalized, context).title;
    await this.runtimeCtx.onReceive(context, normalized, {
      idempotencyKey,
      receivedAt: nowMs,
      ...(suggestedTitle !== undefined ? { suggestedTitle } : {}),
    });
    return true;
  }

  private resolveTargetFromEvent(
    eventType: QqInboundEventType,
    data: QqRawMessageEventData,
    authorId: string,
  ): QqTarget | undefined {
    switch (eventType) {
      case QQ_EVENT_C2C_MESSAGE_CREATE:
        return { scene: "c2c", openId: authorId };
      case QQ_EVENT_GROUP_AT_MESSAGE_CREATE: {
        const groupOpenId = asNonEmptyString(data.group_openid);
        return groupOpenId !== undefined ? { scene: "group", groupOpenId } : undefined;
      }
      case QQ_EVENT_AT_MESSAGE_CREATE: {
        const channelId = asNonEmptyString(data.channel_id);
        if (channelId === undefined) {
          return undefined;
        }
        const guildId = asNonEmptyString(data.guild_id);
        return guildId !== undefined
          ? { scene: "channel", guildId, channelId }
          : { scene: "channel", channelId };
      }
    }
  }
}
