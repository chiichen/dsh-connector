import {
  ConnectorAuthError,
  ConnectorTargetRequiredError,
  ConnectorTransportError,
  ConnectorValidationError,
  prependContextMarker,
  type ConnectorContext,
  type ConnectorSender,
  type ConnectorSendOptions,
  type ContextMarkerStyle,
} from "@dsh-connector/core";
import type { DingTalkAccessTokenManager } from "./auth";
import {
  DINGTALK_ACCESS_TOKEN_HEADER,
  DINGTALK_API_BASE_URL,
  DINGTALK_DEFAULT_HTTP_TIMEOUT_MS,
  DINGTALK_DEFAULT_MARKDOWN_TITLE,
  DINGTALK_GROUP_MESSAGE_SEND_PATH,
  DINGTALK_MARKDOWN_TITLE_MAX_LEN,
  DINGTALK_MAX_OTO_BATCH_USERS,
  DINGTALK_MSG_KEY_MARKDOWN,
  DINGTALK_MSG_KEY_TEXT,
  DINGTALK_OTO_BATCH_SEND_PATH,
  DINGTALK_WEBHOOK_MSGTYPE_MARKDOWN,
  DINGTALK_WEBHOOK_MSGTYPE_TEXT,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_UNAUTHORIZED,
} from "./constants";
import {
  extractProviderErrorDetail,
  isRetryableHttpStatus,
  normalizeDingTalkSessionWebhook,
  requestDingTalkJson,
  type SessionWebhookCache,
} from "./http";
import {
  dingTalkSendSchema,
  parseDingTalkContextTarget,
  type DingTalkResolvedTarget,
  type DingTalkSendParams,
  type DingTalkSendResult,
} from "./types";

export interface DingTalkSenderOptions<TName extends string = string> {
  readonly connectorName: TName;
  readonly robotCode?: string;
  readonly coolAppCode?: string;
  readonly tokenManager?: DingTalkAccessTokenManager;
  readonly webhookCache?: SessionWebhookCache;
  readonly preferSessionWebhook?: boolean;
  readonly defaultFormat?: "text" | "markdown";
  readonly contextMarker?: ContextMarkerStyle | false;
  readonly apiBaseUrl?: string;
  readonly httpTimeoutMs?: number;
  readonly fetchFn?: typeof fetch;
}

function deriveMarkdownTitle(text: string, explicitTitle?: string): string {
  const trimmedExplicit = explicitTitle?.trim();
  if (trimmedExplicit !== undefined && trimmedExplicit.length > 0) {
    return trimmedExplicit.slice(0, DINGTALK_MARKDOWN_TITLE_MAX_LEN);
  }
  const firstNonEmptyLine = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[#>*\-\s`]+/, "").trim())
    .find((line) => line.length > 0);
  if (firstNonEmptyLine !== undefined && firstNonEmptyLine.length > 0) {
    return firstNonEmptyLine.slice(0, DINGTALK_MARKDOWN_TITLE_MAX_LEN);
  }
  return DINGTALK_DEFAULT_MARKDOWN_TITLE;
}

function buildOpenApiMessagePayload(
  wireText: string,
  format: "text" | "markdown",
  explicitTitle?: string,
): { readonly msgKey: string; readonly msgParam: string } {
  if (format === "markdown") {
    return {
      msgKey: DINGTALK_MSG_KEY_MARKDOWN,
      msgParam: JSON.stringify({
        title: deriveMarkdownTitle(wireText, explicitTitle),
        text: wireText,
      }),
    };
  }
  return {
    msgKey: DINGTALK_MSG_KEY_TEXT,
    msgParam: JSON.stringify({ content: wireText }),
  };
}

function deduplicateUserIds(userIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of userIds) {
    const trimmed = raw.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * Outbound DingTalk sender supporting both `sessionWebhook` replies and OpenAPI v1.0 proactive
 * single-chat (`POST /v1.0/robot/oToMessages/batchSend`) & group-chat (`POST /v1.0/robot/groupMessages/send`) delivery.
 *
 * @see https://open.dingtalk.com/document/orgapp/chatbots-send-one-on-one-chat-messages-in-batches.md
 * @see https://open.dingtalk.com/document/orgapp/the-robot-sends-a-group-message.md
 * @see https://open.dingtalk.com/document/development/robot-message-type.md
 */
export class DingTalkSender<TName extends string = string> implements ConnectorSender<
  typeof dingTalkSendSchema,
  DingTalkSendResult,
  TName
> {
  readonly description =
    "Send a text or Markdown message to a DingTalk user, group conversation, or sessionWebhook.";
  readonly schema = dingTalkSendSchema;

  private readonly connectorName: TName;
  private readonly defaultRobotCode: string | undefined;
  private readonly defaultCoolAppCode: string | undefined;
  private readonly tokenManager: DingTalkAccessTokenManager | undefined;
  private readonly webhookCache: SessionWebhookCache | undefined;
  private readonly preferSessionWebhook: boolean;
  private readonly defaultFormat: "text" | "markdown";
  private readonly contextMarker: ContextMarkerStyle | false;
  private readonly apiBaseUrl: string;
  private readonly httpTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: DingTalkSenderOptions<TName>) {
    this.connectorName = options.connectorName;
    this.defaultRobotCode = options.robotCode?.trim();
    this.defaultCoolAppCode = options.coolAppCode?.trim();
    this.tokenManager = options.tokenManager;
    this.webhookCache = options.webhookCache;
    this.preferSessionWebhook = options.preferSessionWebhook ?? options.tokenManager === undefined;
    this.defaultFormat = options.defaultFormat ?? "text";
    this.contextMarker = options.contextMarker ?? "bracket";
    this.apiBaseUrl = (options.apiBaseUrl ?? DINGTALK_API_BASE_URL).replace(/\/+$/, "");
    this.httpTimeoutMs = options.httpTimeoutMs ?? DINGTALK_DEFAULT_HTTP_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async send(
    context: ConnectorContext<TName>,
    params: DingTalkSendParams,
    options?: ConnectorSendOptions,
  ): Promise<DingTalkSendResult> {
    const target = this.resolveTarget(context, params);
    const format = params.format ?? this.defaultFormat;
    const wireText =
      this.contextMarker !== false
        ? prependContextMarker(params.text, context.contextId, this.contextMarker)
        : params.text;

    if (target.kind === "sessionWebhook") {
      return this.sendViaSessionWebhook(target, wireText, format, params, options);
    }
    if (target.kind === "user") {
      return this.sendViaOtoBatch(target, wireText, format, params.title, options);
    }
    return this.sendViaGroupMessage(target, wireText, format, params.title, options);
  }

  private resolveTarget(
    context: ConnectorContext<TName>,
    params: DingTalkSendParams,
  ): DingTalkResolvedTarget {
    const hasExplicitWebhook = params.sessionWebhook !== undefined;
    const hasExplicitGroup = params.openConversationId !== undefined;
    const hasExplicitUser = params.userId !== undefined || params.userIds !== undefined;
    const explicitCount =
      (hasExplicitWebhook ? 1 : 0) + (hasExplicitGroup ? 1 : 0) + (hasExplicitUser ? 1 : 0);

    if (explicitCount > 1) {
      throw new ConnectorValidationError(
        `Connector "${this.connectorName}" received conflicting explicit targets; provide at most one of "sessionWebhook", "openConversationId", or "userId"/"userIds".`,
        { connectorName: this.connectorName },
      );
    }

    if (hasExplicitWebhook && params.sessionWebhook !== undefined) {
      return {
        kind: "sessionWebhook",
        sessionWebhook: normalizeDingTalkSessionWebhook(params.sessionWebhook, this.connectorName),
      };
    }

    if (hasExplicitGroup && params.openConversationId !== undefined) {
      const robotCode = this.requireRobotCode(params.robotCode);
      const coolAppCode = params.coolAppCode?.trim() ?? this.defaultCoolAppCode;
      return {
        kind: "group",
        openConversationId: params.openConversationId.trim(),
        robotCode,
        ...(coolAppCode !== undefined && coolAppCode.length > 0 ? { coolAppCode } : {}),
      };
    }

    if (hasExplicitUser) {
      const mergedUsers = deduplicateUserIds([
        ...(params.userId !== undefined ? [params.userId] : []),
        ...(params.userIds ?? []),
      ]);
      if (mergedUsers.length === 0 || mergedUsers.length > DINGTALK_MAX_OTO_BATCH_USERS) {
        throw new ConnectorValidationError(
          `DingTalk oToMessages/batchSend requires between 1 and ${DINGTALK_MAX_OTO_BATCH_USERS} non-empty userIds.`,
          { connectorName: this.connectorName },
        );
      }
      const robotCode = this.requireRobotCode(params.robotCode);
      return {
        kind: "user",
        userIds: mergedUsers,
        robotCode,
      };
    }

    // Tier 2: Resolve from structured context.contextId
    const parsedContext = parseDingTalkContextTarget(context.contextId);
    const cachedWebhook = this.webhookCache?.get(context.contextId);

    if (parsedContext?.kind === "encryptedUser") {
      if (cachedWebhook !== undefined) {
        return {
          kind: "sessionWebhook",
          sessionWebhook: cachedWebhook.sessionWebhook,
        };
      }
      throw new ConnectorTargetRequiredError(
        this.connectorName,
        "userId | openConversationId | sessionWebhook",
      );
    }

    if (parsedContext !== undefined && this.preferSessionWebhook && cachedWebhook !== undefined) {
      return {
        kind: "sessionWebhook",
        sessionWebhook: cachedWebhook.sessionWebhook,
      };
    }

    if (parsedContext?.kind === "user") {
      if (this.tokenManager === undefined && cachedWebhook !== undefined) {
        return {
          kind: "sessionWebhook",
          sessionWebhook: cachedWebhook.sessionWebhook,
        };
      }
      const robotCode = this.requireRobotCode(params.robotCode);
      return {
        kind: "user",
        userIds: [parsedContext.userId],
        robotCode,
      };
    }

    if (parsedContext?.kind === "group") {
      if (this.tokenManager === undefined && cachedWebhook !== undefined) {
        return {
          kind: "sessionWebhook",
          sessionWebhook: cachedWebhook.sessionWebhook,
        };
      }
      const robotCode = this.requireRobotCode(params.robotCode);
      const coolAppCode = params.coolAppCode?.trim() ?? this.defaultCoolAppCode;
      return {
        kind: "group",
        openConversationId: parsedContext.openConversationId,
        robotCode,
        ...(coolAppCode !== undefined && coolAppCode.length > 0 ? { coolAppCode } : {}),
      };
    }

    // A message-scoped context id (`msg:…` or an extracted marker) is not a DingTalk
    // user/group id. The session webhook cached for that exact context is the reply route.
    if (cachedWebhook !== undefined) {
      return {
        kind: "sessionWebhook",
        sessionWebhook: cachedWebhook.sessionWebhook,
      };
    }

    // Tier 3: Pure pre-allocated UUID or unknown contextId without explicit target
    throw new ConnectorTargetRequiredError(
      this.connectorName,
      "openConversationId | userId | sessionWebhook",
    );
  }

  private requireRobotCode(overrideRobotCode?: string): string {
    const resolved = overrideRobotCode?.trim() ?? this.defaultRobotCode;
    if (resolved === undefined || resolved.length === 0) {
      throw new ConnectorValidationError(
        `Connector "${this.connectorName}" requires "robotCode" (or "clientId") to invoke DingTalk proactive robot OpenAPI.`,
        { connectorName: this.connectorName },
      );
    }
    return resolved;
  }

  private async sendViaSessionWebhook(
    target: Extract<DingTalkResolvedTarget, { readonly kind: "sessionWebhook" }>,
    wireText: string,
    format: "text" | "markdown",
    params: DingTalkSendParams,
    options?: ConnectorSendOptions,
  ): Promise<DingTalkSendResult> {
    const headers: Record<string, string> = {};
    if (this.tokenManager !== undefined) {
      headers[DINGTALK_ACCESS_TOKEN_HEADER] = await this.tokenManager.getAccessToken(
        options?.signal,
      );
    }

    const atPayload: Record<string, unknown> = {};
    if (params.atUserIds !== undefined && params.atUserIds.length > 0) {
      atPayload["atUserIds"] = params.atUserIds;
    }
    if (params.atMobiles !== undefined && params.atMobiles.length > 0) {
      atPayload["atMobiles"] = params.atMobiles;
    }
    if (params.isAtAll === true) {
      atPayload["isAtAll"] = true;
    }

    const body: Record<string, unknown> =
      format === "markdown"
        ? {
            msgtype: DINGTALK_WEBHOOK_MSGTYPE_MARKDOWN,
            markdown: {
              title: deriveMarkdownTitle(params.text, params.title),
              text: wireText,
            },
            ...(Object.keys(atPayload).length > 0 ? { at: atPayload } : {}),
          }
        : {
            msgtype: DINGTALK_WEBHOOK_MSGTYPE_TEXT,
            text: { content: wireText },
            ...(Object.keys(atPayload).length > 0 ? { at: atPayload } : {}),
          };

    const result = await requestDingTalkJson({
      connectorName: this.connectorName,
      fetchFn: this.fetchFn,
      url: target.sessionWebhook,
      method: "POST",
      headers,
      body,
      timeoutMs: this.httpTimeoutMs,
      signal: options?.signal,
    });

    if (!result.ok) {
      const detail = extractProviderErrorDetail(result.data);
      throw new ConnectorTransportError(
        `DingTalk sessionWebhook reply failed (HTTP ${result.status}${detail !== undefined ? ` - ${detail}` : ""}).`,
        {
          connectorName: this.connectorName,
          statusCode: result.status,
          retryable: isRetryableHttpStatus(result.status),
        },
      );
    }

    const errcode = result.data["errcode"];
    if (errcode !== undefined && errcode !== 0 && errcode !== "0") {
      const detail = extractProviderErrorDetail(result.data);
      throw new ConnectorTransportError(
        `DingTalk sessionWebhook rejected message (${detail ?? String(errcode)}).`,
        {
          connectorName: this.connectorName,
          statusCode: result.status,
          retryable: false,
        },
      );
    }

    return {
      channel: "sessionWebhook",
      target,
      raw: result.data,
      summary: "Replied via DingTalk sessionWebhook",
      data: {
        channel: "sessionWebhook",
      },
    };
  }

  private async sendViaOtoBatch(
    target: Extract<DingTalkResolvedTarget, { readonly kind: "user" }>,
    wireText: string,
    format: "text" | "markdown",
    explicitTitle: string | undefined,
    options?: ConnectorSendOptions,
  ): Promise<DingTalkSendResult> {
    const { msgKey, msgParam } = buildOpenApiMessagePayload(wireText, format, explicitTitle);

    const data = await this.postAuthenticatedOpenApi(
      `${this.apiBaseUrl}${DINGTALK_OTO_BATCH_SEND_PATH}`,
      {
        robotCode: target.robotCode,
        userIds: target.userIds,
        msgKey,
        msgParam,
      },
      options?.signal,
    );

    const processQueryKey =
      typeof data["processQueryKey"] === "string" && data["processQueryKey"].trim().length > 0
        ? data["processQueryKey"].trim()
        : undefined;

    return {
      externalId: processQueryKey,
      messageId: processQueryKey,
      channel: "oToMessages",
      target,
      raw: data,
      summary: `Sent DingTalk single-chat message to ${target.userIds.join(", ")}`,
      data: {
        channel: "oToMessages",
        robotCode: target.robotCode,
        userIds: target.userIds,
        ...(processQueryKey !== undefined ? { processQueryKey } : {}),
        ...(Array.isArray(data["invalidStaffIdList"])
          ? { invalidStaffIdList: data["invalidStaffIdList"] }
          : {}),
        ...(Array.isArray(data["flowControlledStaffIdList"])
          ? { flowControlledStaffIdList: data["flowControlledStaffIdList"] }
          : {}),
      },
    };
  }

  private async sendViaGroupMessage(
    target: Extract<DingTalkResolvedTarget, { readonly kind: "group" }>,
    wireText: string,
    format: "text" | "markdown",
    explicitTitle: string | undefined,
    options?: ConnectorSendOptions,
  ): Promise<DingTalkSendResult> {
    const { msgKey, msgParam } = buildOpenApiMessagePayload(wireText, format, explicitTitle);

    const data = await this.postAuthenticatedOpenApi(
      `${this.apiBaseUrl}${DINGTALK_GROUP_MESSAGE_SEND_PATH}`,
      {
        robotCode: target.robotCode,
        openConversationId: target.openConversationId,
        msgKey,
        msgParam,
        ...(target.coolAppCode !== undefined ? { coolAppCode: target.coolAppCode } : {}),
      },
      options?.signal,
    );

    const processQueryKey =
      typeof data["processQueryKey"] === "string" && data["processQueryKey"].trim().length > 0
        ? data["processQueryKey"].trim()
        : undefined;

    return {
      externalId: processQueryKey,
      messageId: processQueryKey,
      channel: "groupMessages",
      target,
      raw: data,
      summary: `Sent DingTalk group message to ${target.openConversationId}`,
      data: {
        channel: "groupMessages",
        robotCode: target.robotCode,
        openConversationId: target.openConversationId,
        ...(processQueryKey !== undefined ? { processQueryKey } : {}),
      },
    };
  }

  private async postAuthenticatedOpenApi(
    url: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (this.tokenManager === undefined) {
      throw new ConnectorAuthError(
        `Connector "${this.connectorName}" requires "clientId" and "clientSecret" to call DingTalk OpenAPI.`,
        { connectorName: this.connectorName },
      );
    }

    const executeRequest = async (): Promise<Awaited<ReturnType<typeof requestDingTalkJson>>> => {
      const token = await this.tokenManager!.getAccessToken(signal);
      return requestDingTalkJson({
        connectorName: this.connectorName,
        fetchFn: this.fetchFn,
        url,
        method: "POST",
        headers: {
          [DINGTALK_ACCESS_TOKEN_HEADER]: token,
        },
        body,
        timeoutMs: this.httpTimeoutMs,
        signal,
      });
    };

    let result = await executeRequest();
    if (!result.ok && result.status === HTTP_STATUS_UNAUTHORIZED) {
      this.tokenManager.invalidate();
      result = await executeRequest();
    }

    if (result.ok) {
      return result.data;
    }

    const detail = extractProviderErrorDetail(result.data);
    if (result.status === HTTP_STATUS_UNAUTHORIZED || result.status === HTTP_STATUS_FORBIDDEN) {
      throw new ConnectorAuthError(
        `DingTalk OpenAPI authentication/permission rejected (HTTP ${result.status}${detail !== undefined ? ` - ${detail}` : ""}).`,
        { connectorName: this.connectorName },
      );
    }

    throw new ConnectorTransportError(
      `DingTalk OpenAPI request failed (HTTP ${result.status}${detail !== undefined ? ` - ${detail}` : ""}).`,
      {
        connectorName: this.connectorName,
        statusCode: result.status,
        retryable: isRetryableHttpStatus(result.status),
      },
    );
  }
}
