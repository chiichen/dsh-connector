import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
  prependContextMarker,
  type ConnectorContext,
  type ConnectorSendOptions,
} from "@dsh-connector/core";
import { buildQqSendEndpoint, getQqTargetKey, resolveQqSendTarget } from "./addressing";
import type { QqAccessTokenManager } from "./auth";
import {
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_UNAUTHORIZED,
  QQ_C2C_PASSIVE_MAX_REPLIES,
  QQ_C2C_PASSIVE_TTL_MS,
  QQ_CHANNEL_PASSIVE_TTL_MS,
  QQ_DEFAULT_API_BASE_URL,
  QQ_DEFAULT_REQUEST_TIMEOUT_MS,
  QQ_ERR_CODE_AUDIT_PENDING_PUSH,
  QQ_ERR_CODE_AUDIT_PENDING_REPLY,
  QQ_ERR_CODE_MARKDOWN_NOT_ALLOWED,
  QQ_GROUP_PASSIVE_MAX_REPLIES,
  QQ_GROUP_PASSIVE_TTL_MS,
  QQ_INITIAL_MSG_SEQ,
  QQ_MAX_TRACKED_MSG_SEQS,
  QQ_MAX_TRACKED_PASSIVE_TARGETS,
  QQ_MSG_TYPE_MARKDOWN,
  QQ_MSG_TYPE_TEXT,
} from "./constants";
import type {
  QqMessageFormat,
  QqRawSendResponse,
  QqSendInput,
  QqSendResult,
  QqTarget,
} from "./types";
import { qqSendSchema } from "./types";

interface PassiveTargetWindow {
  readonly msgId: string;
  readonly expiresAtMs: number;
  readonly maxReplies: number | undefined;
  usedReplies: number;
}

function passiveTtlMsForTarget(target: QqTarget): number {
  switch (target.scene) {
    case "c2c":
      return QQ_C2C_PASSIVE_TTL_MS;
    case "group":
      return QQ_GROUP_PASSIVE_TTL_MS;
    case "channel":
      return QQ_CHANNEL_PASSIVE_TTL_MS;
  }
}

function maxPassiveRepliesForTarget(target: QqTarget): number | undefined {
  switch (target.scene) {
    case "c2c":
      return QQ_C2C_PASSIVE_MAX_REPLIES;
    case "group":
      return QQ_GROUP_PASSIVE_MAX_REPLIES;
    case "channel":
      return undefined;
  }
}

function evictOldestIfOverCapacity<K, V>(map: Map<K, V>, maxEntries: number): void {
  for (const key of map.keys()) {
    if (map.size <= maxEntries) {
      break;
    }
    map.delete(key);
  }
}

/**
 * Tracks active passive reply windows (`msg_id`) per conversation target and
 * monotonically increments `msg_seq` per `msg_id` to prevent QQ deduplication
 * rejections (`40054005`).
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
 */
export class QqPassiveReplyTracker {
  private readonly targetWindows = new Map<string, PassiveTargetWindow>();
  private readonly msgSeqByMsgId = new Map<string, number>();

  /**
   * Records a newly received inbound message ID so subsequent replies in the same
   * chat automatically attach passive `msg_id` while within TTL and quota.
   */
  recordInbound(target: QqTarget, msgId: string, nowMs = Date.now()): void {
    const trimmedId = msgId.trim();
    if (trimmedId.length === 0) {
      return;
    }
    const key = getQqTargetKey(target);
    this.targetWindows.delete(key);
    this.targetWindows.set(key, {
      msgId: trimmedId,
      expiresAtMs: nowMs + passiveTtlMsForTarget(target),
      maxReplies: maxPassiveRepliesForTarget(target),
      usedReplies: 0,
    });
    evictOldestIfOverCapacity(this.targetWindows, QQ_MAX_TRACKED_PASSIVE_TARGETS);
  }

  /**
   * Resolves the active passive `msg_id` for a target if still within TTL and reply quota.
   */
  consumeAutoPassiveMsgId(target: QqTarget, nowMs = Date.now()): string | undefined {
    const key = getQqTargetKey(target);
    const window = this.targetWindows.get(key);
    if (window === undefined) {
      return undefined;
    }
    if (nowMs >= window.expiresAtMs) {
      this.targetWindows.delete(key);
      return undefined;
    }
    if (window.maxReplies !== undefined && window.usedReplies >= window.maxReplies) {
      return undefined;
    }
    window.usedReplies += 1;
    return window.msgId;
  }

  /**
   * Allocates the next strictly increasing `msg_seq` for a given `msg_id` (`1, 2, 3, ...`),
   * or advances past an caller-supplied `explicitMsgSeq`.
   */
  nextMsgSeq(msgId: string, explicitMsgSeq?: number): number {
    const previous = this.msgSeqByMsgId.get(msgId) ?? 0;
    const next =
      explicitMsgSeq !== undefined
        ? Math.max(explicitMsgSeq, previous + QQ_INITIAL_MSG_SEQ)
        : previous + QQ_INITIAL_MSG_SEQ;
    this.msgSeqByMsgId.delete(msgId);
    this.msgSeqByMsgId.set(msgId, next);
    evictOldestIfOverCapacity(this.msgSeqByMsgId, QQ_MAX_TRACKED_MSG_SEQS);
    return next;
  }
}

export interface QqMessageSenderOptions {
  readonly connectorName: string;
  readonly tokenManager: QqAccessTokenManager;
  readonly passiveTracker?: QqPassiveReplyTracker;
  readonly apiBaseUrl?: string;
  readonly defaultFormat?: QqMessageFormat;
  readonly includeContextMarker?: boolean;
  readonly autoPassiveReply?: boolean;
  readonly fallbackToPlainOnMarkdownReject?: boolean;
  readonly requestTimeoutMs?: number;
  readonly fetchFn?: typeof fetch;
}

export interface QqSendCallOptions extends ConnectorSendOptions {
  readonly nowMs?: number;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function buildRequestBody(
  target: QqTarget,
  wireText: string,
  format: QqMessageFormat,
  passiveMsgId: string | undefined,
  eventId: string | undefined,
  msgSeq: number | undefined,
): Record<string, unknown> {
  if (target.scene === "channel") {
    const payload: Record<string, unknown> =
      format === "markdown" ? { markdown: { content: wireText } } : { content: wireText };
    if (passiveMsgId !== undefined) {
      payload["msg_id"] = passiveMsgId;
    } else if (eventId !== undefined) {
      payload["event_id"] = eventId;
    }
    return payload;
  }

  const payload: Record<string, unknown> =
    format === "markdown"
      ? {
          msg_type: QQ_MSG_TYPE_MARKDOWN,
          markdown: { content: wireText },
        }
      : {
          msg_type: QQ_MSG_TYPE_TEXT,
          content: wireText,
        };

  if (passiveMsgId !== undefined) {
    payload["msg_id"] = passiveMsgId;
    if (msgSeq !== undefined) {
      payload["msg_seq"] = msgSeq;
    }
  } else if (eventId !== undefined) {
    payload["event_id"] = eventId;
    if (msgSeq !== undefined) {
      payload["msg_seq"] = msgSeq;
    }
  }

  return payload;
}

/**
 * Outbound OpenAPI message sender supporting QQ C2C (`/v2/users/{openid}/messages`),
 * Group (`/v2/groups/{group_openid}/messages`), and Guild Channel (`/channels/{channel_id}/messages`).
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/send.html
 */
export class QqMessageSender<TName extends string = string> {
  private readonly connectorName: TName;
  private readonly tokenManager: QqAccessTokenManager;
  private readonly passiveTracker: QqPassiveReplyTracker;
  private readonly apiBaseUrl: string;
  private readonly defaultFormat: QqMessageFormat;
  private readonly includeContextMarker: boolean;
  private readonly autoPassiveReply: boolean;
  private readonly fallbackToPlainOnMarkdownReject: boolean;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: QqMessageSenderOptions & { readonly connectorName: TName }) {
    this.connectorName = options.connectorName;
    this.tokenManager = options.tokenManager;
    this.passiveTracker = options.passiveTracker ?? new QqPassiveReplyTracker();
    this.apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? QQ_DEFAULT_API_BASE_URL);
    this.defaultFormat = options.defaultFormat ?? "plain";
    this.includeContextMarker = options.includeContextMarker ?? true;
    this.autoPassiveReply = options.autoPassiveReply ?? true;
    this.fallbackToPlainOnMarkdownReject = options.fallbackToPlainOnMarkdownReject ?? true;
    this.requestTimeoutMs = options.requestTimeoutMs ?? QQ_DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  getPassiveTracker(): QqPassiveReplyTracker {
    return this.passiveTracker;
  }

  async send(
    context: ConnectorContext<TName>,
    rawParams: QqSendInput,
    options?: QqSendCallOptions,
  ): Promise<QqSendResult> {
    options?.signal?.throwIfAborted();

    const params = qqSendSchema.parse(rawParams);
    if (params.replyToMessageId !== undefined && params.eventId !== undefined) {
      throw new ConnectorValidationError(
        "QQ replyToMessageId (msg_id) and eventId (event_id) are mutually exclusive.",
        { connectorName: this.connectorName },
      );
    }

    const target = resolveQqSendTarget(this.connectorName, context, params);
    const shouldIncludeMarker = params.includeContextMarker ?? this.includeContextMarker;
    const wireText = shouldIncludeMarker
      ? prependContextMarker(params.text, context.contextId, "bracket")
      : params.text;

    const passiveMsgId =
      params.replyToMessageId ??
      (params.eventId === undefined && this.autoPassiveReply
        ? this.passiveTracker.consumeAutoPassiveMsgId(target, options?.nowMs)
        : undefined);

    const requestedFormat = params.format ?? this.defaultFormat;
    const endpointUrl = `${this.apiBaseUrl}${buildQqSendEndpoint(target)}`;

    const allocateSeq = (explicit?: number): number | undefined => {
      if (target.scene === "channel") {
        return undefined;
      }
      if (passiveMsgId !== undefined) {
        return this.passiveTracker.nextMsgSeq(passiveMsgId, explicit);
      }
      return explicit;
    };

    const firstMsgSeq = allocateSeq(params.msgSeq);
    const firstAttempt = await this.postWithAuthRetry(
      endpointUrl,
      buildRequestBody(
        target,
        wireText,
        requestedFormat,
        passiveMsgId,
        params.eventId,
        firstMsgSeq,
      ),
      options?.signal,
    );

    if (
      !firstAttempt.ok &&
      requestedFormat === "markdown" &&
      this.fallbackToPlainOnMarkdownReject &&
      firstAttempt.body.code === QQ_ERR_CODE_MARKDOWN_NOT_ALLOWED
    ) {
      const fallbackMsgSeq = allocateSeq();
      const fallbackAttempt = await this.postWithAuthRetry(
        endpointUrl,
        buildRequestBody(target, wireText, "plain", passiveMsgId, params.eventId, fallbackMsgSeq),
        options?.signal,
      );
      return this.toSendResult(
        target,
        fallbackAttempt.status,
        fallbackAttempt.ok,
        fallbackAttempt.body,
        passiveMsgId,
        fallbackMsgSeq,
      );
    }

    return this.toSendResult(
      target,
      firstAttempt.status,
      firstAttempt.ok,
      firstAttempt.body,
      passiveMsgId,
      firstMsgSeq,
    );
  }

  private async postWithAuthRetry(
    url: string,
    payload: Record<string, unknown>,
    callerSignal?: AbortSignal,
  ): Promise<{ readonly status: number; readonly ok: boolean; readonly body: QqRawSendResponse }> {
    const first = await this.executePost(url, payload, callerSignal);
    if (first.status !== HTTP_STATUS_UNAUTHORIZED) {
      return first;
    }

    this.tokenManager.invalidate();
    return this.executePost(url, payload, callerSignal);
  }

  private async executePost(
    url: string,
    payload: Record<string, unknown>,
    callerSignal?: AbortSignal,
  ): Promise<{ readonly status: number; readonly ok: boolean; readonly body: QqRawSendResponse }> {
    const authHeader = await this.tokenManager.getAuthorizationHeader(callerSignal);
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const requestSignal =
      callerSignal !== undefined ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: requestSignal,
      });
    } catch (cause) {
      if (callerSignal?.aborted === true) {
        throw callerSignal.reason ?? cause;
      }
      throw new ConnectorTransportError(`QQ OpenAPI request to ${url} failed.`, {
        connectorName: this.connectorName,
        retryable: true,
        cause,
      });
    }

    let parsedBody: QqRawSendResponse = {};
    const rawText = await response.text();
    if (rawText.trim().length > 0) {
      try {
        parsedBody = JSON.parse(rawText) as QqRawSendResponse;
      } catch (cause) {
        throw new ConnectorTransportError(`QQ OpenAPI response from ${url} was not valid JSON.`, {
          connectorName: this.connectorName,
          statusCode: response.status,
          retryable: response.status >= HTTP_STATUS_INTERNAL_SERVER_ERROR,
          cause,
        });
      }
    }

    return {
      status: response.status,
      ok: response.ok,
      body: parsedBody,
    };
  }

  private toSendResult(
    target: QqTarget,
    status: number,
    ok: boolean,
    body: QqRawSendResponse,
    passiveMsgId: string | undefined,
    msgSeq: number | undefined,
  ): QqSendResult {
    const auditId = body.data?.message_audit?.audit_id;
    const isAuditQueued =
      (body.code === QQ_ERR_CODE_AUDIT_PENDING_PUSH ||
        body.code === QQ_ERR_CODE_AUDIT_PENDING_REPLY) &&
      typeof auditId === "string" &&
      auditId.length > 0;

    if (!isAuditQueued) {
      if (status === HTTP_STATUS_UNAUTHORIZED || status === HTTP_STATUS_FORBIDDEN) {
        throw new ConnectorAuthError(
          `QQ OpenAPI rejected authorization with HTTP ${status}${body.message !== undefined ? `: ${body.message}` : ""}.`,
          { connectorName: this.connectorName },
        );
      }

      if (!ok || (typeof body.code === "number" && body.code !== 0)) {
        const detail =
          body.code !== undefined
            ? `code=${body.code}${body.message !== undefined ? `: ${body.message}` : ""}`
            : `HTTP ${status}`;
        throw new ConnectorTransportError(`QQ OpenAPI message send failed (${detail}).`, {
          connectorName: this.connectorName,
          statusCode: status,
          retryable:
            status === HTTP_STATUS_TOO_MANY_REQUESTS || status >= HTTP_STATUS_INTERNAL_SERVER_ERROR,
        });
      }
    }

    const messageId =
      typeof body.id === "string" && body.id.length > 0
        ? body.id
        : isAuditQueued
          ? `audit:${auditId}`
          : "unknown";
    const refIdx = body.ext_info?.ref_idx;
    const targetSummary = getQqTargetKey(target);

    return {
      externalId: messageId,
      summary: isAuditQueued
        ? `Queued QQ message for audit (${auditId}) to ${targetSummary}`
        : `Sent QQ message (${messageId}) to ${targetSummary}`,
      messageId,
      target,
      ...(passiveMsgId !== undefined ? { passiveMsgId } : {}),
      ...(msgSeq !== undefined ? { msgSeq } : {}),
      ...(refIdx !== undefined ? { refIdx } : {}),
      ...(body.timestamp !== undefined ? { timestamp: body.timestamp } : {}),
      ...(auditId !== undefined ? { auditId } : {}),
      raw: body,
      data: {
        messageId,
        target: targetSummary,
        ...(passiveMsgId !== undefined ? { passiveMsgId } : {}),
        ...(msgSeq !== undefined ? { msgSeq } : {}),
        ...(refIdx !== undefined ? { refIdx } : {}),
        ...(auditId !== undefined ? { auditId } : {}),
      },
    };
  }
}
