import {
  ConnectorAuthError,
  ConnectorValidationError,
  assertValidConnectorName,
  createConnectorContext,
  extractContextMarker,
  prependContextMarker,
  type Connector,
  type ConnectorContext,
  type ConnectorLogger,
  type ConnectorInboundPrompt,
  type ConnectorReceiver,
  type ConnectorReceiverContext,
  type ConnectorSender,
  type ConnectorSendOptions,
  type ConnectorWebhookRequest,
  type ConnectorWebhookResponse,
  type ContextMarkerStyle,
} from "@dsh-connector/core";
import { WeixinApiClient, type IlinkRawMessage, type IlinkRawMessageItem } from "./api-client";
import { splitWeixinText } from "./chunker";
import {
  CONTENT_TYPE_TEXT_PLAIN_UTF8,
  DEFAULT_CONTEXT_TOKEN_CACHE_SIZE,
  DEFAULT_DEDUP_CACHE_SIZE,
  DEFAULT_ILINK_LONG_POLL_TIMEOUT_MS,
  DEFAULT_MAX_MESSAGE_CHARS,
  DEFAULT_OFFICIAL_MAX_MESSAGE_BYTES,
  DEFAULT_POLL_RETRY_BASE_DELAY_MS,
  DEFAULT_POLL_RETRY_MAX_DELAY_MS,
  DEFAULT_WEIXIN_CONNECTOR_NAME,
  DEFAULT_WEIXIN_DESCRIPTION,
  DEFAULT_WEIXIN_DISPLAY_NAME,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_OK,
  HTTP_STATUS_UNAUTHORIZED,
  ILINK_ITEM_TYPE_TEXT,
  ILINK_ITEM_TYPE_VOICE,
  ILINK_MESSAGE_TYPE_BOT,
  MILLISECONDS_PER_SECOND,
  WEIXIN_ENCRYPT_TYPE_AES,
  WEIXIN_WEBHOOK_ACK_BODY,
} from "./constants";
import { formatWeixinP2pContextId, resolveWeixinSendTarget } from "./context-target";
import {
  decodeEncodingAesKey,
  decryptWeixinCiphertext,
  verifyWeixinMsgSignature,
  verifyWeixinSignature,
} from "./crypto";
import { BoundedIdSet } from "./dedup";
import type { WeixinAiMsgContext, WeixinStreamingAdapter } from "./streaming";
import { WeixinAccessTokenManager } from "./token-manager";
import {
  weixinReceiveSchema,
  weixinSendSchema,
  type WeixinConnectorMode,
  type WeixinConnectorOptions,
  type WeixinIlinkOptions,
  type WeixinOfficialAccountOptions,
  type WeixinReceiveParams,
  type WeixinSendParams,
  type WeixinSendResult,
} from "./types";
import { parseWeixinCallbackBody } from "./xml";

function textResponse(status: number, body: string): ConnectorWebhookResponse {
  return {
    status,
    headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN_UTF8 },
    body,
  };
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseNumericOrder(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const num = Number(value);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return undefined;
}

/**
 * Orders an iLink batch deterministically by `seq` or `create_time_ms` when present on all items.
 */
export function orderIlinkMessages(
  messages: readonly IlinkRawMessage[],
): readonly IlinkRawMessage[] {
  if (messages.length < 2) {
    return messages;
  }

  const orderField: "seq" | "create_time_ms" | undefined = (
    ["seq", "create_time_ms"] as const
  ).find((field) => messages.every((msg) => parseNumericOrder(msg[field]) !== undefined));

  if (orderField === undefined) {
    return messages;
  }

  return messages
    .map((msg, index) => ({
      msg,
      index,
      order: parseNumericOrder(msg[orderField])!,
    }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map((entry) => entry.msg);
}

function extractIlinkContent(items: readonly IlinkRawMessageItem[]): {
  readonly msgType: "text" | "voice";
  readonly text: string;
} | null {
  for (const item of items) {
    if (item.type === ILINK_ITEM_TYPE_TEXT && typeof item.text_item?.text === "string") {
      const trimmed = item.text_item.text.trim();
      if (trimmed.length > 0) {
        return { msgType: "text", text: trimmed };
      }
    }
    if (item.type === ILINK_ITEM_TYPE_VOICE && typeof item.voice_item?.text === "string") {
      const trimmed = item.voice_item.text.trim();
      if (trimmed.length > 0) {
        return { msgType: "voice", text: trimmed };
      }
    }
  }
  return null;
}

function extractIlinkQuote(items: readonly IlinkRawMessageItem[]): {
  readonly quotedMessageId?: string;
  readonly quotedText?: string;
} {
  for (const item of items) {
    const ref = item.ref_msg;
    if (ref === undefined) {
      continue;
    }
    const quotedItem = ref.message_item;
    const rawQuotedId = quotedItem?.msg_id;
    const quotedMessageId =
      typeof rawQuotedId === "string" && rawQuotedId.trim().length > 0
        ? rawQuotedId.trim()
        : typeof rawQuotedId === "number"
          ? String(rawQuotedId)
          : undefined;
    const quotedTextCandidate =
      quotedItem?.text_item?.text?.trim() ??
      quotedItem?.voice_item?.text?.trim() ??
      ref.title?.trim();
    const quotedText =
      quotedTextCandidate !== undefined && quotedTextCandidate.length > 0
        ? quotedTextCandidate
        : undefined;
    if (quotedMessageId !== undefined || quotedText !== undefined) {
      return {
        ...(quotedMessageId !== undefined ? { quotedMessageId } : {}),
        ...(quotedText !== undefined ? { quotedText } : {}),
      };
    }
  }
  return {};
}

function isIlinkOptions<TName extends string>(
  options: WeixinConnectorOptions<TName>,
): options is WeixinIlinkOptions<TName> {
  return options.mode === "ilink";
}

/**
 * Bidirectional WeChat connector supporting both:
 * 1. Official WeChat Official Account / Service Account / Customer Service HTTP callbacks
 *    (SHA-1 signature + `echostr` verification + optional `WXBizMsgCrypt` AES-256-CBC encryption)
 *    paired with `POST /cgi-bin/message/custom/send` outbound delivery; and
 * 2. WeChat iLink Bot HTTPS long-polling (`getupdates` + `sendmessage`).
 *
 * Reserves `getStreamingAdapter()` and `streaming` options for future `message/custom/typing`
 * and progressive reply segment adapters without coupling non-streaming operation to streaming.
 *
 * @see https://developers.weixin.qq.com/doc/service/guide/dev/push/
 * @see https://developers.weixin.qq.com/doc/oplatform/developers/dev/push/encryption.html
 * @see https://developers.weixin.qq.com/doc/service/guide/product/message/Receiving_standard_messages.html
 * @see https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html
 * @see https://developers.weixin.qq.com/doc/subscription/api/customer/message/api_typing.html
 */
export class WeixinConnector<
  const TName extends string = typeof DEFAULT_WEIXIN_CONNECTOR_NAME,
> implements Connector<
  TName,
  typeof weixinSendSchema,
  typeof weixinReceiveSchema,
  WeixinSendResult
> {
  readonly name: TName;
  readonly displayName: string;
  readonly description: string;
  readonly mode: WeixinConnectorMode;

  private readonly maxMessageChars: number;
  private readonly maxMessageBytes: number;
  private readonly contextMarkerStyle: ContextMarkerStyle | "none";
  private readonly allowedSenderSet: ReadonlySet<string> | undefined;
  private readonly streamingAdapter: WeixinStreamingAdapter | undefined;

  private readonly officialConfig:
    | {
        readonly appId: string;
        readonly token: string;
        readonly encodingAesKey?: string;
        readonly accountId?: string;
        readonly kfAccount?: string;
        readonly businessId?: string;
        readonly aiMsgContext?: WeixinAiMsgContext;
      }
    | undefined;

  private readonly ilinkConfig:
    | {
        readonly botUserId?: string;
        readonly pollTimeoutMs: number;
        readonly pollRetryBaseDelayMs: number;
        readonly pollRetryMaxDelayMs: number;
        readonly onUpdatesBufChange?: (updatesBuf: string) => Promise<void> | void;
      }
    | undefined;

  private readonly apiClient: WeixinApiClient;
  private readonly seenInboundIds: BoundedIdSet;
  private readonly selfSentMessageIds: BoundedIdSet;
  private readonly contextTokensByUser = new Map<string, string>();

  private receiverCtx: ConnectorReceiverContext<typeof weixinReceiveSchema, TName> | undefined;
  private readonly hostLogger: ConnectorLogger | undefined;
  private updatesBuf = "";
  private pollAbortController: AbortController | undefined;
  private pollLoopPromise: Promise<void> | undefined;

  private readonly sender: ConnectorSender<typeof weixinSendSchema, WeixinSendResult, TName>;
  private readonly receiver: ConnectorReceiver<typeof weixinReceiveSchema, TName>;

  constructor(options: WeixinConnectorOptions<TName>) {
    const resolvedName = (options.name ?? DEFAULT_WEIXIN_CONNECTOR_NAME) as TName;
    assertValidConnectorName(resolvedName);
    this.name = resolvedName;
    this.hostLogger = options.logger;
    this.displayName = options.displayName ?? DEFAULT_WEIXIN_DISPLAY_NAME;
    this.description = options.description ?? DEFAULT_WEIXIN_DESCRIPTION;

    this.maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
    this.contextMarkerStyle = options.contextMarkerStyle ?? "none";
    this.streamingAdapter = options.streamingAdapter ?? options.streaming?.adapter;

    const dedupSize = options.deduplicationMaxEntries ?? DEFAULT_DEDUP_CACHE_SIZE;
    this.seenInboundIds = new BoundedIdSet(dedupSize);
    this.selfSentMessageIds = new BoundedIdSet(dedupSize);

    if (options.allowedSenderIds !== undefined && options.allowedSenderIds.length > 0) {
      this.allowedSenderSet = new Set(
        options.allowedSenderIds.map((id) => id.trim()).filter((id) => id.length > 0),
      );
    }

    if (isIlinkOptions(options)) {
      const botToken = options.botToken.trim();
      if (botToken.length === 0) {
        throw new ConnectorValidationError(
          "Weixin iLink connector requires a non-empty botToken.",
          {
            connectorName: this.name,
          },
        );
      }
      this.mode = "ilink";
      this.maxMessageBytes = options.maxMessageBytes ?? 0;
      this.updatesBuf = options.initialUpdatesBuf ?? "";
      const botUserId = options.botUserId?.trim();
      this.ilinkConfig = {
        ...(botUserId !== undefined && botUserId.length > 0 ? { botUserId } : {}),
        pollTimeoutMs: options.pollTimeoutMs ?? DEFAULT_ILINK_LONG_POLL_TIMEOUT_MS,
        pollRetryBaseDelayMs: options.pollRetryBaseDelayMs ?? DEFAULT_POLL_RETRY_BASE_DELAY_MS,
        pollRetryMaxDelayMs: options.pollRetryMaxDelayMs ?? DEFAULT_POLL_RETRY_MAX_DELAY_MS,
        ...(options.onUpdatesBufChange !== undefined
          ? { onUpdatesBufChange: options.onUpdatesBufChange }
          : {}),
      };
      this.apiClient = new WeixinApiClient({
        connectorName: this.name,
        mode: "ilink",
        botToken,
        ilinkBaseUrl: options.baseUrl,
        timeoutMs: options.timeoutMs,
        fetchFn: options.fetchFn,
      });
    } else {
      const officialOpts: WeixinOfficialAccountOptions<TName> = options;
      const appId = officialOpts.appId.trim();
      const callbackToken = officialOpts.token.trim();
      if (appId.length === 0 || callbackToken.length === 0) {
        throw new ConnectorValidationError(
          "Weixin official-account connector requires non-empty appId and token.",
          { connectorName: this.name },
        );
      }

      const encodingAesKey = officialOpts.encodingAesKey?.trim();
      if (encodingAesKey !== undefined && encodingAesKey.length > 0) {
        decodeEncodingAesKey(encodingAesKey, this.name);
      }

      this.mode = "official-account";
      this.maxMessageBytes = officialOpts.maxMessageBytes ?? DEFAULT_OFFICIAL_MAX_MESSAGE_BYTES;
      const accountId = officialOpts.accountId?.trim();
      const kfAccount = officialOpts.kfAccount?.trim();
      const businessId = officialOpts.businessId?.trim();

      this.officialConfig = {
        appId,
        token: callbackToken,
        ...(encodingAesKey !== undefined && encodingAesKey.length > 0 ? { encodingAesKey } : {}),
        ...(accountId !== undefined && accountId.length > 0 ? { accountId } : {}),
        ...(kfAccount !== undefined && kfAccount.length > 0 ? { kfAccount } : {}),
        ...(businessId !== undefined && businessId.length > 0 ? { businessId } : {}),
        ...(officialOpts.aiMsgContext !== undefined
          ? { aiMsgContext: officialOpts.aiMsgContext }
          : {}),
      };

      const tokenManager = new WeixinAccessTokenManager({
        connectorName: this.name,
        appId,
        appSecret: officialOpts.appSecret,
        accessToken: officialOpts.accessToken,
        accessTokenProvider: officialOpts.accessTokenProvider,
        tokenStrategy: officialOpts.tokenStrategy,
        refreshMarginMs: officialOpts.tokenRefreshMarginMs,
        apiBaseUrl: officialOpts.apiBaseUrl,
        timeoutMs: officialOpts.timeoutMs,
        fetchFn: officialOpts.fetchFn,
      });

      this.apiClient = new WeixinApiClient({
        connectorName: this.name,
        mode: "official-account",
        tokenManager,
        apiBaseUrl: officialOpts.apiBaseUrl,
        timeoutMs: officialOpts.timeoutMs,
        fetchFn: officialOpts.fetchFn,
      });
    }

    this.sender = {
      description: this.description,
      schema: weixinSendSchema,
      send: (context, params, sendOptions) => this.handleSend(context, params, sendOptions),
    };

    this.receiver = {
      schema: weixinReceiveSchema,
      init: (ctx) => {
        this.receiverCtx = ctx;
      },
      formatInbound: (params) => this.renderInboundPrompt(params),
      handleWebhook: (req) => this.handleWebhookRequest(req),
    };
  }

  getSender(): ConnectorSender<typeof weixinSendSchema, WeixinSendResult, TName> {
    return this.sender;
  }

  getReceiver(): ConnectorReceiver<typeof weixinReceiveSchema, TName> {
    return this.receiver;
  }

  /**
   * Returns the reserved `WeixinStreamingAdapter` if configured, or `undefined` in standard
   * non-streaming operation.
   */
  getStreamingAdapter(): WeixinStreamingAdapter | undefined {
    return this.streamingAdapter;
  }

  private inboundLogger(): ConnectorLogger | undefined {
    return this.receiverCtx?.logger ?? this.hostLogger;
  }

  async start(): Promise<void> {
    if (this.mode !== "ilink") {
      return;
    }
    if (this.pollLoopPromise !== undefined) {
      return;
    }

    await this.apiClient.ilinkNotifyStart();
    const abortController = new AbortController();
    this.pollAbortController = abortController;
    this.pollLoopPromise = this.runIlinkPollLoop(abortController.signal);
  }

  async stop(): Promise<void> {
    if (this.mode !== "ilink") {
      return;
    }
    const controller = this.pollAbortController;
    const loopPromise = this.pollLoopPromise;
    this.pollAbortController = undefined;
    this.pollLoopPromise = undefined;

    if (controller !== undefined) {
      controller.abort();
    }
    if (loopPromise !== undefined) {
      await loopPromise.catch(() => undefined);
    }
    if (controller !== undefined) {
      try {
        await this.apiClient.ilinkNotifyStop();
      } catch (error) {
        this.inboundLogger()?.warn("Failed to notify Weixin iLink stop", {
          connectorName: this.name,
          error: String(error),
        });
      }
    }
  }

  private renderInboundPrompt(params: WeixinReceiveParams): ConnectorInboundPrompt {
    const lines: string[] = [];
    if (params.quotedText !== undefined && params.quotedText.length > 0) {
      const quotedLines = params.quotedText
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      lines.push(quotedLines, "");
    }
    lines.push(params.text);

    return {
      title: `[Weixin] ${params.senderId}`,
      text: lines.join("\n"),
    };
  }

  private async handleSend(
    context: ConnectorContext<TName>,
    rawParams: WeixinSendParams,
    options?: ConnectorSendOptions,
  ): Promise<WeixinSendResult> {
    const params = weixinSendSchema.parse(rawParams);
    const targetId = resolveWeixinSendTarget(this.name, context.contextId, params);

    const textWithOptionalMarker =
      this.contextMarkerStyle === "none"
        ? params.text
        : prependContextMarker(params.text, context.contextId, this.contextMarkerStyle);

    const chunks = splitWeixinText(textWithOptionalMarker, {
      maxChars: this.maxMessageChars,
      maxUtf8Bytes: this.maxMessageBytes,
    });

    const messageIds: string[] = [];
    const rawResponses: Array<Record<string, unknown>> = [];
    let resolvedContextToken: string | undefined;

    for (const chunk of chunks) {
      if (this.mode === "official-account") {
        const res = await this.apiClient.sendCustomTextMessage({
          openId: targetId,
          content: chunk,
          kfAccount: params.kfAccount ?? this.officialConfig?.kfAccount,
          businessId: params.businessId ?? this.officialConfig?.businessId,
          aiMsgContext: this.officialConfig?.aiMsgContext,
          signal: options?.signal,
        });
        this.selfSentMessageIds.add(res.messageId);
        messageIds.push(res.messageId);
        rawResponses.push(res.raw);
      } else {
        resolvedContextToken =
          params.contextToken?.trim() ?? this.contextTokensByUser.get(targetId);
        const res = await this.apiClient.ilinkSendTextMessage({
          toUserId: targetId,
          text: chunk,
          contextToken: resolvedContextToken,
          signal: options?.signal,
        });
        this.selfSentMessageIds.add(res.messageId);
        messageIds.push(res.messageId);
        rawResponses.push(res.raw);
      }
    }

    const firstMessageId = messageIds[0]!;
    return {
      externalId: firstMessageId,
      summary: `Sent ${chunks.length} Weixin message chunk(s) to ${targetId}`,
      messageId: firstMessageId,
      messageIds,
      openId: targetId,
      chunkCount: chunks.length,
      mode: this.mode,
      ...(resolvedContextToken !== undefined ? { contextToken: resolvedContextToken } : {}),
      data: {
        messageId: firstMessageId,
        messageIds,
        openId: targetId,
        chunkCount: chunks.length,
        mode: this.mode,
      },
      raw: rawResponses,
    };
  }

  private async handleWebhookRequest(
    req: ConnectorWebhookRequest,
  ): Promise<ConnectorWebhookResponse> {
    if (this.mode !== "official-account" || this.officialConfig === undefined) {
      return textResponse(
        HTTP_STATUS_METHOD_NOT_ALLOWED,
        "Webhook callback is only supported in official-account mode.",
      );
    }

    const method = req.method.toUpperCase();
    if (method === "GET") {
      return this.handleWebhookVerification(req);
    }
    if (method === "POST") {
      return this.handleWebhookPost(req);
    }
    return textResponse(HTTP_STATUS_METHOD_NOT_ALLOWED, `Method ${method} Not Allowed`);
  }

  /**
   * Handles WeChat server `GET` URL verification (`signature` + `timestamp` + `nonce` -> `echostr`).
   *
   * @see https://developers.weixin.qq.com/doc/service/guide/dev/push/
   */
  private handleWebhookVerification(req: ConnectorWebhookRequest): ConnectorWebhookResponse {
    const signature = req.query.get("signature");
    const timestamp = req.query.get("timestamp");
    const nonce = req.query.get("nonce");
    const echostr = req.query.get("echostr");

    if (
      signature === null ||
      timestamp === null ||
      nonce === null ||
      echostr === null ||
      signature.length === 0 ||
      timestamp.length === 0 ||
      nonce.length === 0
    ) {
      return textResponse(
        HTTP_STATUS_BAD_REQUEST,
        "Missing required WeChat verification query parameters.",
      );
    }

    if (!verifyWeixinSignature(this.officialConfig!.token, timestamp, nonce, signature)) {
      return textResponse(HTTP_STATUS_UNAUTHORIZED, "Invalid WeChat callback signature.");
    }

    return textResponse(HTTP_STATUS_OK, echostr);
  }

  /**
   * Handles WeChat server `POST` message/event push in Plaintext, Compatible, or Safe (`AES-256-CBC`) mode.
   *
   * @see https://developers.weixin.qq.com/doc/oplatform/developers/dev/push/encryption.html
   * @see https://developers.weixin.qq.com/doc/service/guide/product/message/Receiving_standard_messages.html
   */
  private async handleWebhookPost(req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse> {
    const config = this.officialConfig!;
    const timestamp = req.query.get("timestamp");
    const nonce = req.query.get("nonce");

    if (timestamp === null || nonce === null || timestamp.length === 0 || nonce.length === 0) {
      return textResponse(HTTP_STATUS_BAD_REQUEST, "Missing timestamp or nonce query parameters.");
    }

    const rawText = new TextDecoder().decode(req.rawBody);
    let outerFields: Record<string, string>;
    try {
      outerFields = parseWeixinCallbackBody(rawText, this.name);
    } catch {
      return textResponse(HTTP_STATUS_BAD_REQUEST, "Malformed WeChat callback payload.");
    }

    const encryptType = req.query.get("encrypt_type")?.toLowerCase();
    const encryptedField = outerFields["Encrypt"];
    const isEncrypted =
      encryptType === WEIXIN_ENCRYPT_TYPE_AES ||
      (encryptedField !== undefined && encryptedField.length > 0 && req.query.has("msg_signature"));

    let messageFields: Record<string, string>;

    if (isEncrypted) {
      if (config.encodingAesKey === undefined) {
        return textResponse(
          HTTP_STATUS_BAD_REQUEST,
          "EncodingAESKey is required for encrypted WeChat callbacks.",
        );
      }
      if (encryptedField === undefined || encryptedField.length === 0) {
        return textResponse(
          HTTP_STATUS_BAD_REQUEST,
          "Missing Encrypt field in encrypted callback.",
        );
      }
      const msgSignature = req.query.get("msg_signature");
      if (
        msgSignature === null ||
        !verifyWeixinMsgSignature(config.token, timestamp, nonce, encryptedField, msgSignature)
      ) {
        return textResponse(HTTP_STATUS_UNAUTHORIZED, "Invalid WeChat msg_signature.");
      }

      try {
        const decrypted = decryptWeixinCiphertext({
          encodingAesKey: config.encodingAesKey,
          cipherTextBase64: encryptedField,
          expectedAppId: config.appId,
          connectorName: this.name,
        });
        messageFields = parseWeixinCallbackBody(decrypted.plaintext, this.name);
      } catch (error) {
        if (error instanceof ConnectorAuthError) {
          return textResponse(HTTP_STATUS_UNAUTHORIZED, error.message);
        }
        return textResponse(HTTP_STATUS_BAD_REQUEST, "Failed to decrypt WeChat callback payload.");
      }
    } else {
      const signature = req.query.get("signature");
      if (signature === null || !verifyWeixinSignature(config.token, timestamp, nonce, signature)) {
        return textResponse(HTTP_STATUS_UNAUTHORIZED, "Invalid WeChat callback signature.");
      }
      messageFields = outerFields;
    }

    await this.dispatchOfficialInboundMessage(messageFields, timestamp);
    return textResponse(HTTP_STATUS_OK, WEIXIN_WEBHOOK_ACK_BODY);
  }

  private async dispatchOfficialInboundMessage(
    fields: Record<string, string>,
    fallbackTimestamp: string,
  ): Promise<void> {
    if (this.receiverCtx === undefined) {
      return;
    }

    const msgType = (fields["MsgType"] ?? "").trim().toLowerCase();
    let rawContent: string | undefined;
    let normalizedMsgType: "text" | "voice" | undefined;

    if (msgType === "text") {
      rawContent = fields["Content"];
      normalizedMsgType = "text";
    } else if (msgType === "voice") {
      rawContent = fields["Recognition"];
      normalizedMsgType = "voice";
    }

    if (
      normalizedMsgType === undefined ||
      rawContent === undefined ||
      rawContent.trim().length === 0
    ) {
      return;
    }

    const senderId = (fields["FromUserName"] ?? "").trim();
    const recipientId = (fields["ToUserName"] ?? "").trim();

    if (senderId.length === 0) {
      return;
    }
    // Anti-loop: ignore messages originating from the bot account itself
    if (
      (this.officialConfig?.accountId !== undefined &&
        senderId === this.officialConfig.accountId) ||
      (recipientId.length > 0 && senderId === recipientId)
    ) {
      return;
    }
    if (this.allowedSenderSet !== undefined && !this.allowedSenderSet.has(senderId)) {
      return;
    }

    const createTimeRaw = fields["CreateTime"] ?? fallbackTimestamp;
    const createTimeSec = Number(createTimeRaw);
    const createTimeMs =
      Number.isFinite(createTimeSec) && createTimeSec >= 0
        ? Math.trunc(createTimeSec * MILLISECONDS_PER_SECOND)
        : undefined;

    const rawMsgId = (fields["MsgId"] ?? "").trim();
    const messageId = rawMsgId.length > 0 ? rawMsgId : `${senderId}:${createTimeRaw}`;

    if (this.selfSentMessageIds.has(messageId) || !this.seenInboundIds.add(messageId)) {
      return;
    }

    const { contextId: markerContextId, cleanedContent } = extractContextMarker(rawContent);
    const finalText = cleanedContent.trim();
    if (finalText.length === 0) {
      return;
    }

    const resolvedContextId = markerContextId ?? formatWeixinP2pContextId(senderId, this.name);
    const context = createConnectorContext(this, resolvedContextId);

    const msgDataId = fields["MsgDataId"]?.trim();
    const idx = fields["Idx"]?.trim();

    const payload: WeixinReceiveParams = {
      mode: "official-account",
      messageId,
      senderId,
      ...(recipientId.length > 0 ? { recipientId } : {}),
      msgType: normalizedMsgType,
      text: finalText,
      ...(createTimeMs !== undefined ? { createTimeMs } : {}),
      ...(msgDataId !== undefined && msgDataId.length > 0 ? { msgDataId } : {}),
      ...(idx !== undefined && idx.length > 0 ? { idx } : {}),
    };

    await this.receiverCtx.onReceive(context, payload, {
      idempotencyKey: messageId,
      suggestedTitle: `[Weixin] ${senderId}`,
      ...(createTimeMs !== undefined ? { receivedAt: createTimeMs } : {}),
    });
  }

  private rememberContextToken(userId: string, contextToken: string): void {
    const trimmed = contextToken.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (this.contextTokensByUser.has(userId)) {
      this.contextTokensByUser.delete(userId);
    } else if (this.contextTokensByUser.size >= DEFAULT_CONTEXT_TOKEN_CACHE_SIZE) {
      const oldest = this.contextTokensByUser.keys().next();
      if (!oldest.done) {
        this.contextTokensByUser.delete(oldest.value);
      }
    }
    this.contextTokensByUser.set(userId, trimmed);
  }

  private async runIlinkPollLoop(signal: AbortSignal): Promise<void> {
    const config = this.ilinkConfig!;
    let consecutiveFailures = 0;

    while (!signal.aborted) {
      try {
        const result = await this.apiClient.ilinkGetUpdates({
          getUpdatesBuf: this.updatesBuf,
          timeoutMs: config.pollTimeoutMs,
          signal,
        });
        if (signal.aborted) {
          return;
        }
        consecutiveFailures = 0;

        for (const msg of orderIlinkMessages(result.msgs)) {
          if (signal.aborted) {
            return;
          }
          await this.dispatchIlinkInboundMessage(msg);
        }

        if (result.getUpdatesBuf.length > 0 && result.getUpdatesBuf !== this.updatesBuf) {
          this.updatesBuf = result.getUpdatesBuf;
          await config.onUpdatesBufChange?.(this.updatesBuf);
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (error instanceof ConnectorAuthError) {
          this.inboundLogger()?.error("Weixin iLink authentication failed; stopping poll loop", {
            connectorName: this.name,
            error: error.message,
          });
          return;
        }
        consecutiveFailures += 1;
        const backoffMs = Math.min(
          config.pollRetryBaseDelayMs * 2 ** (consecutiveFailures - 1),
          config.pollRetryMaxDelayMs,
        );
        this.inboundLogger()?.warn("Weixin iLink poll failed; backing off", {
          connectorName: this.name,
          attempt: consecutiveFailures,
          backoffMs,
          error: String(error),
        });
        await abortableDelay(backoffMs, signal);
      }
    }
  }

  private async dispatchIlinkInboundMessage(msg: IlinkRawMessage): Promise<void> {
    if (this.receiverCtx === undefined) {
      return;
    }
    // Filter out bot-originated echo messages
    if (msg.message_type === ILINK_MESSAGE_TYPE_BOT) {
      return;
    }

    const senderId = typeof msg.from_user_id === "string" ? msg.from_user_id.trim() : "";
    if (senderId.length === 0) {
      return;
    }
    if (this.ilinkConfig?.botUserId !== undefined && senderId === this.ilinkConfig.botUserId) {
      return;
    }
    if (this.allowedSenderSet !== undefined && !this.allowedSenderSet.has(senderId)) {
      return;
    }

    const rawId =
      msg.message_id !== undefined && msg.message_id !== null
        ? String(msg.message_id).trim()
        : (msg.client_id?.trim() ?? "");
    if (rawId.length === 0) {
      return;
    }
    if (this.selfSentMessageIds.has(rawId) || !this.seenInboundIds.add(rawId)) {
      return;
    }

    if (typeof msg.context_token === "string" && msg.context_token.trim().length > 0) {
      this.rememberContextToken(senderId, msg.context_token);
    }

    const items = Array.isArray(msg.item_list) ? msg.item_list : [];
    const extracted = extractIlinkContent(items);
    if (extracted === null) {
      return;
    }

    const quote = extractIlinkQuote(items);
    const { contextId: directMarkerId, cleanedContent } = extractContextMarker(extracted.text);
    const quoteMarker =
      quote.quotedText !== undefined ? extractContextMarker(quote.quotedText) : undefined;

    const finalText = cleanedContent.trim();
    if (finalText.length === 0) {
      return;
    }

    const resolvedContextId =
      directMarkerId ?? quoteMarker?.contextId ?? formatWeixinP2pContextId(senderId, this.name);
    const context = createConnectorContext(this, resolvedContextId);

    const createTimeNum = parseNumericOrder(msg.create_time_ms);
    const createTimeMs =
      createTimeNum !== undefined && createTimeNum >= 0 ? Math.trunc(createTimeNum) : undefined;
    const recipientId = typeof msg.to_user_id === "string" ? msg.to_user_id.trim() : "";
    const cleanedQuotedText = quoteMarker?.cleanedContent.trim();
    const contextToken = msg.context_token?.trim();

    const payload: WeixinReceiveParams = {
      mode: "ilink",
      messageId: rawId,
      senderId,
      ...(recipientId.length > 0 ? { recipientId } : {}),
      msgType: extracted.msgType,
      text: finalText,
      ...(createTimeMs !== undefined ? { createTimeMs } : {}),
      ...(quote.quotedMessageId !== undefined ? { quotedMessageId: quote.quotedMessageId } : {}),
      ...(cleanedQuotedText !== undefined && cleanedQuotedText.length > 0
        ? { quotedText: cleanedQuotedText }
        : {}),
      ...(contextToken !== undefined && contextToken.length > 0 ? { contextToken } : {}),
    };

    await this.receiverCtx.onReceive(context, payload, {
      idempotencyKey: rawId,
      suggestedTitle: `[Weixin] ${senderId}`,
      ...(createTimeMs !== undefined ? { receivedAt: createTimeMs } : {}),
    });
  }
}

/**
 * Factory function creating a typed `WeixinConnector` instance.
 *
 * @see https://developers.weixin.qq.com/doc/service/guide/dev/push/
 * @see https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html
 */
export function createWeixinConnector<
  const TName extends string = typeof DEFAULT_WEIXIN_CONNECTOR_NAME,
>(options: WeixinConnectorOptions<TName>): WeixinConnector<TName> {
  return new WeixinConnector(options);
}
