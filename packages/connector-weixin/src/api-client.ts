import { randomBytes, randomUUID } from "node:crypto";
import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
} from "@dsh-connector/core";
import {
  CONTENT_TYPE_APPLICATION_JSON,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_ILINK_LONG_POLL_TIMEOUT_MS,
  HTTP_STATUS_SERVER_ERROR_MIN,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  ILINK_ITEM_TYPE_TEXT,
  ILINK_MESSAGE_STATE_DONE,
  ILINK_MESSAGE_TYPE_BOT,
  WEIXIN_AUTH_ERRCODES,
  WEIXIN_CUSTOM_SEND_PATH,
  WEIXIN_CUSTOM_TYPING_PATH,
  WEIXIN_ERRCODE_OK,
  WEIXIN_ERRCODE_SYSTEM_BUSY,
  WEIXIN_ILINK_APP_ID,
  WEIXIN_ILINK_AUTH_TYPE,
  WEIXIN_ILINK_BASE_URL,
  WEIXIN_ILINK_BOT_AGENT,
  WEIXIN_ILINK_CLIENT_ID_PREFIX,
  WEIXIN_ILINK_CLIENT_VERSION,
  WEIXIN_ILINK_GET_UPDATES_PATH,
  WEIXIN_ILINK_NOTIFY_START_PATH,
  WEIXIN_ILINK_NOTIFY_STOP_PATH,
  WEIXIN_ILINK_PROTOCOL_VERSION,
  WEIXIN_ILINK_SEND_MESSAGE_PATH,
  WEIXIN_ILINK_SEND_TYPING_PATH,
  WEIXIN_ILINK_STALE_TOKEN_CODE,
  WEIXIN_OFFICIAL_API_BASE_URL,
  WEIXIN_RATE_LIMIT_ERRCODE,
  WEIXIN_TOKEN_EXPIRED_ERRCODES,
  WEIXIN_UIN_RANDOM_BYTES,
} from "./constants";
import type { WeixinAiMsgContext, WeixinTypingCommand } from "./streaming";
import type { WeixinAccessTokenManager } from "./token-manager";
import type { WeixinConnectorMode } from "./types";

export interface WeixinApiClientOptions {
  readonly connectorName: string;
  readonly mode: WeixinConnectorMode;
  readonly tokenManager?: WeixinAccessTokenManager;
  readonly apiBaseUrl?: string;
  readonly botToken?: string;
  readonly ilinkBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
}

export interface SendCustomTextRequest {
  readonly openId: string;
  readonly content: string;
  readonly kfAccount?: string;
  readonly businessId?: string;
  readonly aiMsgContext?: WeixinAiMsgContext;
  readonly signal?: AbortSignal;
}

export interface SendCustomTypingRequest {
  readonly openId: string;
  readonly command: WeixinTypingCommand;
  readonly businessId?: string;
  readonly signal?: AbortSignal;
}

export interface SendTextChunkResponse {
  readonly messageId: string;
  readonly raw: Record<string, unknown>;
}

export interface IlinkRawMessageItem {
  readonly type?: number;
  readonly text_item?: { readonly text?: string };
  readonly voice_item?: { readonly text?: string };
  readonly ref_msg?: {
    readonly title?: string;
    readonly message_item?: {
      readonly msg_id?: string | number;
      readonly type?: number;
      readonly text_item?: { readonly text?: string };
      readonly voice_item?: { readonly text?: string };
    };
  };
}

export interface IlinkRawMessage {
  readonly message_id?: string | number;
  readonly client_id?: string;
  readonly from_user_id?: string;
  readonly to_user_id?: string;
  readonly message_type?: number;
  readonly seq?: number | string;
  readonly create_time_ms?: number | string;
  readonly context_token?: string;
  readonly item_list?: readonly IlinkRawMessageItem[];
}

export interface IlinkGetUpdatesResult {
  readonly msgs: readonly IlinkRawMessage[];
  readonly getUpdatesBuf: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * Unified HTTP transport client for Official WeChat Customer Service APIs (`api.weixin.qq.com`)
 * and WeChat iLink Bot endpoints (`ilinkai.weixin.qq.com`).
 *
 * @see https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html
 * @see https://developers.weixin.qq.com/doc/subscription/api/customer/message/api_typing.html
 */
export class WeixinApiClient {
  private readonly connectorName: string;
  private readonly mode: WeixinConnectorMode;
  private readonly tokenManager: WeixinAccessTokenManager | undefined;
  private readonly apiBaseUrl: string;
  private readonly botToken: string | undefined;
  private readonly ilinkBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: WeixinApiClientOptions) {
    this.connectorName = options.connectorName;
    this.mode = options.mode;
    this.tokenManager = options.tokenManager;
    this.apiBaseUrl = (options.apiBaseUrl ?? WEIXIN_OFFICIAL_API_BASE_URL).replace(/\/+$/, "");
    this.botToken = options.botToken?.trim();
    this.ilinkBaseUrl = normalizeTrailingSlash(options.ilinkBaseUrl ?? WEIXIN_ILINK_BASE_URL);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /**
   * Sends a text message via `POST https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=...`.
   * Automatically refreshes `access_token` and retries once on `errcode` `40001` / `40014` / `42001`.
   *
   * @see https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html
   */
  async sendCustomTextMessage(req: SendCustomTextRequest): Promise<SendTextChunkResponse> {
    const payload: Record<string, unknown> = {
      touser: req.openId,
      msgtype: "text",
      text: { content: req.content },
    };
    if (req.kfAccount !== undefined && req.kfAccount.trim().length > 0) {
      payload["customservice"] = { kf_account: req.kfAccount.trim() };
    }
    if (req.businessId !== undefined && req.businessId.trim().length > 0) {
      payload["businessid"] = req.businessId.trim();
    }
    if (req.aiMsgContext !== undefined) {
      payload["aimsgcontext"] = req.aiMsgContext;
    }

    const body = await this.callOfficialEndpointWithRetry(
      WEIXIN_CUSTOM_SEND_PATH,
      payload,
      req.signal,
    );

    const rawMsgId = body["msgid"];
    const messageId =
      typeof rawMsgId === "string" && rawMsgId.trim().length > 0
        ? rawMsgId.trim()
        : typeof rawMsgId === "number"
          ? String(rawMsgId)
          : `wx-custom-${randomUUID()}`;

    return { messageId, raw: body };
  }

  /**
   * Sends or cancels Customer Service typing indicator via
   * `POST https://api.weixin.qq.com/cgi-bin/message/custom/typing?access_token=...`.
   *
   * @see https://developers.weixin.qq.com/doc/subscription/api/customer/message/api_typing.html
   */
  async sendCustomTyping(req: SendCustomTypingRequest): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      touser: req.openId,
      command: req.command,
    };
    if (req.businessId !== undefined && req.businessId.trim().length > 0) {
      payload["businessid"] = req.businessId.trim();
    }
    return this.callOfficialEndpointWithRetry(WEIXIN_CUSTOM_TYPING_PATH, payload, req.signal);
  }

  async ilinkNotifyStart(options?: {
    readonly signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    return this.callIlinkEndpoint(
      WEIXIN_ILINK_NOTIFY_START_PATH,
      { base_info: this.ilinkBaseInfo() },
      this.timeoutMs,
      options?.signal,
    );
  }

  async ilinkNotifyStop(options?: {
    readonly signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    return this.callIlinkEndpoint(
      WEIXIN_ILINK_NOTIFY_STOP_PATH,
      { base_info: this.ilinkBaseInfo() },
      this.timeoutMs,
      options?.signal,
    );
  }

  async ilinkGetUpdates(options: {
    readonly getUpdatesBuf: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<IlinkGetUpdatesResult> {
    try {
      const response = await this.callIlinkEndpoint(
        WEIXIN_ILINK_GET_UPDATES_PATH,
        {
          get_updates_buf: options.getUpdatesBuf,
          base_info: this.ilinkBaseInfo(),
        },
        options.timeoutMs ?? DEFAULT_ILINK_LONG_POLL_TIMEOUT_MS,
        options.signal,
      );
      const msgs = Array.isArray(response["msgs"])
        ? (response["msgs"] as readonly IlinkRawMessage[])
        : [];
      const nextBuf =
        typeof response["get_updates_buf"] === "string" && response["get_updates_buf"].length > 0
          ? response["get_updates_buf"]
          : options.getUpdatesBuf;
      return { msgs, getUpdatesBuf: nextBuf };
    } catch (error) {
      if (
        options.signal?.aborted !== true &&
        error instanceof ConnectorTransportError &&
        error.statusCode === undefined &&
        error.message.includes("timed out")
      ) {
        return { msgs: [], getUpdatesBuf: options.getUpdatesBuf };
      }
      throw error;
    }
  }

  async ilinkSendTextMessage(req: {
    readonly toUserId: string;
    readonly text: string;
    readonly contextToken?: string;
    readonly clientId?: string;
    readonly signal?: AbortSignal;
  }): Promise<SendTextChunkResponse> {
    const clientId = req.clientId ?? `${WEIXIN_ILINK_CLIENT_ID_PREFIX}${randomUUID()}`;
    const msgPayload: Record<string, unknown> = {
      from_user_id: "",
      to_user_id: req.toUserId,
      client_id: clientId,
      message_type: ILINK_MESSAGE_TYPE_BOT,
      message_state: ILINK_MESSAGE_STATE_DONE,
      item_list: [{ type: ILINK_ITEM_TYPE_TEXT, text_item: { text: req.text } }],
    };
    if (req.contextToken !== undefined && req.contextToken.trim().length > 0) {
      msgPayload["context_token"] = req.contextToken.trim();
    }

    const raw = await this.callIlinkEndpoint(
      WEIXIN_ILINK_SEND_MESSAGE_PATH,
      {
        msg: msgPayload,
        base_info: this.ilinkBaseInfo(),
      },
      this.timeoutMs,
      req.signal,
    );

    return { messageId: clientId, raw };
  }

  async ilinkSendTyping(req: {
    readonly toUserId: string;
    readonly typingTicket: string;
    readonly status: 1 | 2;
    readonly signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    return this.callIlinkEndpoint(
      WEIXIN_ILINK_SEND_TYPING_PATH,
      {
        ilink_user_id: req.toUserId,
        typing_ticket: req.typingTicket,
        status: req.status,
        base_info: this.ilinkBaseInfo(),
      },
      this.timeoutMs,
      req.signal,
    );
  }

  private async callOfficialEndpointWithRetry(
    path: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (this.mode !== "official-account" || this.tokenManager === undefined) {
      throw new ConnectorValidationError(
        "Official WeChat API endpoint called without an initialized tokenManager.",
        { connectorName: this.connectorName },
      );
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const accessToken = await this.tokenManager.getAccessToken({
        forceRefresh: attempt > 0,
        signal,
      });
      const url = new URL(`${this.apiBaseUrl}${path}`);
      url.searchParams.set("access_token", accessToken);

      const body = await this.executeJsonPost(
        url.toString(),
        { "content-type": CONTENT_TYPE_APPLICATION_JSON },
        payload,
        this.timeoutMs,
        signal,
      );

      const errcode = typeof body["errcode"] === "number" ? body["errcode"] : WEIXIN_ERRCODE_OK;
      if (errcode === WEIXIN_ERRCODE_OK) {
        return body;
      }

      if (attempt === 0 && WEIXIN_TOKEN_EXPIRED_ERRCODES.includes(errcode)) {
        this.tokenManager.invalidate();
        continue;
      }

      const errmsg = typeof body["errmsg"] === "string" ? body["errmsg"] : "unknown error";
      if (WEIXIN_AUTH_ERRCODES.includes(errcode)) {
        throw new ConnectorAuthError(
          `Weixin API auth failed on ${path} (errcode=${errcode}): ${errmsg}`,
          { connectorName: this.connectorName },
        );
      }

      throw new ConnectorTransportError(
        `Weixin API error on ${path} (errcode=${errcode}): ${errmsg}`,
        {
          connectorName: this.connectorName,
          retryable:
            errcode === WEIXIN_ERRCODE_SYSTEM_BUSY || errcode === WEIXIN_RATE_LIMIT_ERRCODE,
        },
      );
    }

    throw new ConnectorTransportError(`Unexpected retry exhaustion on ${path}.`, {
      connectorName: this.connectorName,
    });
  }

  private ilinkBaseInfo(): Record<string, string> {
    return {
      channel_version: WEIXIN_ILINK_PROTOCOL_VERSION,
      bot_agent: WEIXIN_ILINK_BOT_AGENT,
    };
  }

  private ilinkHeaders(): Record<string, string> {
    if (this.botToken === undefined || this.botToken.length === 0) {
      throw new ConnectorValidationError("Weixin iLink mode requires a non-empty botToken.", {
        connectorName: this.connectorName,
      });
    }
    const randomUin = randomBytes(WEIXIN_UIN_RANDOM_BYTES).readUInt32BE(0);
    return {
      "content-type": CONTENT_TYPE_APPLICATION_JSON,
      "iLink-App-Id": WEIXIN_ILINK_APP_ID,
      "iLink-App-ClientVersion": String(WEIXIN_ILINK_CLIENT_VERSION),
      AuthorizationType: WEIXIN_ILINK_AUTH_TYPE,
      Authorization: `Bearer ${this.botToken}`,
      "X-WECHAT-UIN": Buffer.from(String(randomUin), "utf8").toString("base64"),
    };
  }

  private async callIlinkEndpoint(
    endpointPath: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = new URL(endpointPath, this.ilinkBaseUrl).toString();
    const body = await this.executeJsonPost(url, this.ilinkHeaders(), payload, timeoutMs, signal);

    const ret = typeof body["ret"] === "number" ? body["ret"] : WEIXIN_ERRCODE_OK;
    const errcode = typeof body["errcode"] === "number" ? body["errcode"] : WEIXIN_ERRCODE_OK;
    const failureCode = ret !== WEIXIN_ERRCODE_OK ? ret : errcode;

    if (failureCode !== WEIXIN_ERRCODE_OK) {
      if (failureCode === WEIXIN_ILINK_STALE_TOKEN_CODE) {
        throw new ConnectorAuthError(
          `Weixin iLink botToken is stale or expired (code=${failureCode}).`,
          { connectorName: this.connectorName },
        );
      }
      throw new ConnectorTransportError(
        `Weixin iLink API error on ${endpointPath} (code=${failureCode}).`,
        {
          connectorName: this.connectorName,
          retryable: failureCode === WEIXIN_ERRCODE_SYSTEM_BUSY,
        },
      );
    }

    return body;
  }

  private async executeJsonPost(
    url: string,
    headers: Record<string, string>,
    payload: Record<string, unknown>,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (callerSignal?.aborted === true) {
      throw callerSignal.reason instanceof Error
        ? callerSignal.reason
        : new ConnectorTransportError("Weixin HTTP request aborted before dispatch.", {
            connectorName: this.connectorName,
            retryable: false,
          });
    }

    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    const onCallerAbort = (): void => {
      callerAborted = true;
      controller.abort(callerSignal?.reason);
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (callerAborted) {
        throw callerSignal?.reason instanceof Error ? callerSignal.reason : error;
      }
      throw new ConnectorTransportError(
        timedOut ? `Weixin request timed out (${url}).` : `Weixin network request failed (${url}).`,
        {
          connectorName: this.connectorName,
          cause: error,
          retryable: true,
        },
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }

    if (!response.ok) {
      throw new ConnectorTransportError(`Weixin HTTP ${response.status} error (${url}).`, {
        connectorName: this.connectorName,
        statusCode: response.status,
        retryable:
          response.status === HTTP_STATUS_TOO_MANY_REQUESTS ||
          response.status >= HTTP_STATUS_SERVER_ERROR_MIN,
      });
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new ConnectorTransportError(`Invalid JSON response from Weixin API (${url}).`, {
        connectorName: this.connectorName,
        cause: error,
        retryable: false,
      });
    }

    if (!isRecord(parsed)) {
      throw new ConnectorTransportError(`Unexpected non-object JSON from Weixin API (${url}).`, {
        connectorName: this.connectorName,
        retryable: false,
      });
    }

    return parsed;
  }
}
