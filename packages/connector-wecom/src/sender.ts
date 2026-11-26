/**
 * Enterprise WeChat (WeCom) unified outbound `ConnectorSender` implementation.
 *
 * Enforces 3-tier target resolution:
 * 1. Explicit target parameters on `params` (`webhookKey`, `responseUrl`, `reqId`, `chatId`, `toUser`/`toParty`/`toTag`)
 * 2. Structured business target decoded from `context.contextId` (`app:p2p:...`, `app:group:...`, `aibot:p2p:...`, `aibot:group:...`, `webhook:...`)
 * 3. Throws `ConnectorTargetRequiredError` (never mistakes pre-allocated session UUIDs for WeCom targets)
 *
 * @see https://developer.work.weixin.qq.com/document/path/96458 Self-built app message sending
 * @see https://developer.work.weixin.qq.com/document/path/90248 App group chat message sending
 * @see https://developer.work.weixin.qq.com/document/path/99110 Group webhook bot message sending
 * @see https://developer.work.weixin.qq.com/document/path/101138 Intelligent Bot `response_url` reply
 * @see https://developer.work.weixin.qq.com/document/path/101463 Intelligent Bot WebSocket `aibot_send_msg` & `aibot_respond_msg`
 */

import {
  ConnectorTargetRequiredError,
  ConnectorTransportError,
  ConnectorValidationError,
  prependContextMarker,
  type ConnectorContext,
  type ConnectorSendOptions,
  type ConnectorSender,
  type ContextMarkerStyle,
} from "@dsh-connector/core";
import type { WeComApiClient, WeComApiResponse } from "./api-client";
import {
  WECOM_AIBOT_CHAT_TYPE_GROUP,
  WECOM_AIBOT_CHAT_TYPE_SINGLE,
  WECOM_AIBOT_MARKDOWN_MAX_BYTES,
  WECOM_APP_TEXT_MAX_BYTES,
  WECOM_WEBHOOK_MARKDOWN_MAX_BYTES,
  WECOM_WEBHOOK_TEXT_MAX_BYTES,
} from "./constants";
import { parseWeComContextTarget, splitUtf8ByBytes } from "./context-target";
import {
  wecomSendSchema,
  type WeComMessageFormat,
  type WeComOutboundChannel,
  type WeComSendParams,
  type WeComSendResult,
} from "./types";

export interface WeComAibotOutboundTransport {
  isConnected(): boolean;
  sendProactiveMarkdown(
    input: {
      readonly chatId: string;
      readonly chatType: typeof WECOM_AIBOT_CHAT_TYPE_SINGLE | typeof WECOM_AIBOT_CHAT_TYPE_GROUP;
      readonly content: string;
    },
    options?: ConnectorSendOptions,
  ): Promise<{ readonly reqId: string; readonly raw: Readonly<Record<string, unknown>> }>;
  respondMarkdown(
    input: {
      readonly reqId: string;
      readonly content: string;
    },
    options?: ConnectorSendOptions,
  ): Promise<{ readonly reqId: string; readonly raw: Readonly<Record<string, unknown>> }>;
  consumeCachedResponseUrl?(contextId: string): string | undefined;
}

export interface WeComSenderOptions<TName extends string = "wecom"> {
  readonly connectorName: TName;
  readonly apiClient: WeComApiClient;
  readonly aibotTransport?: WeComAibotOutboundTransport;
  readonly consumeCachedResponseUrl?: (contextId: string) => string | undefined;
  readonly defaultConversationChannel?: "app" | "aibot";
  readonly includeContextMarkerByDefault?: boolean;
  readonly contextMarkerStyle?: ContextMarkerStyle;
  readonly description?: string;
}

type ResolvedOutboundPlan =
  | {
      readonly channel: "webhook";
      readonly webhookKey: string;
      readonly targetLabel: string;
    }
  | {
      readonly channel: "app";
      readonly toUser?: string;
      readonly toParty?: string;
      readonly toTag?: string;
      readonly targetLabel: string;
    }
  | {
      readonly channel: "appchat";
      readonly chatId: string;
      readonly targetLabel: string;
    }
  | {
      readonly channel: "aibot";
      readonly mode: "response_url";
      readonly responseUrl: string;
      readonly targetLabel: string;
    }
  | {
      readonly channel: "aibot";
      readonly mode: "ws_respond";
      readonly reqId: string;
      readonly targetLabel: string;
    }
  | {
      readonly channel: "aibot";
      readonly mode: "ws_proactive";
      readonly chatId: string;
      readonly chatType: typeof WECOM_AIBOT_CHAT_TYPE_SINGLE | typeof WECOM_AIBOT_CHAT_TYPE_GROUP;
      readonly targetLabel: string;
    };

export class WeComSender<TName extends string = "wecom"> implements ConnectorSender<
  typeof wecomSendSchema,
  WeComSendResult,
  TName
> {
  readonly schema = wecomSendSchema;
  readonly description: string;
  private readonly connectorName: TName;
  private readonly apiClient: WeComApiClient;
  private readonly aibotTransport: WeComAibotOutboundTransport | undefined;
  private readonly consumeCachedResponseUrl:
    | ((contextId: string) => string | undefined)
    | undefined;
  private readonly defaultConversationChannel: "app" | "aibot";
  private readonly includeContextMarkerByDefault: boolean;
  private readonly contextMarkerStyle: ContextMarkerStyle;

  constructor(options: WeComSenderOptions<TName>) {
    this.connectorName = options.connectorName;
    this.apiClient = options.apiClient;
    this.aibotTransport = options.aibotTransport;
    this.consumeCachedResponseUrl =
      options.consumeCachedResponseUrl ??
      (options.aibotTransport?.consumeCachedResponseUrl !== undefined
        ? (ctxId) => options.aibotTransport?.consumeCachedResponseUrl?.(ctxId)
        : undefined);
    this.defaultConversationChannel =
      options.defaultConversationChannel ??
      (options.apiClient.app === undefined && options.aibotTransport !== undefined
        ? "aibot"
        : "app");
    this.includeContextMarkerByDefault = options.includeContextMarkerByDefault ?? true;
    this.contextMarkerStyle = options.contextMarkerStyle ?? "bracket";
    this.description =
      options.description ??
      `Send a WeCom message via self-built app, app group chat, group webhook bot, or Intelligent Bot (${options.connectorName}).`;
  }

  async send(
    context: ConnectorContext<TName>,
    params: WeComSendParams,
    options?: ConnectorSendOptions,
  ): Promise<WeComSendResult> {
    const parsed = this.schema.parse(params);
    const plan = this.resolveTargetPlan(context, parsed);

    const shouldPrependMarker = parsed.includeContextMarker ?? this.includeContextMarkerByDefault;
    const fullContent = shouldPrependMarker
      ? prependContextMarker(parsed.text, context.contextId, this.contextMarkerStyle)
      : parsed.text;

    switch (plan.channel) {
      case "webhook":
        return this.deliverWebhook(plan.webhookKey, plan.targetLabel, fullContent, parsed, options);
      case "app":
        return this.deliverApp(plan, fullContent, parsed, options);
      case "appchat":
        return this.deliverAppChat(plan.chatId, plan.targetLabel, fullContent, parsed, options);
      case "aibot":
        return this.deliverAibot(plan, fullContent, options);
    }
  }

  private resolveTargetPlan(
    context: ConnectorContext<TName>,
    params: WeComSendParams,
  ): ResolvedOutboundPlan {
    // Tier 1: Explicit target parameters in `params`
    if (params.webhookKey !== undefined) {
      return {
        channel: "webhook",
        webhookKey: params.webhookKey,
        targetLabel: `webhook:${params.webhookKey}`,
      };
    }

    if (params.responseUrl !== undefined) {
      return {
        channel: "aibot",
        mode: "response_url",
        responseUrl: params.responseUrl,
        targetLabel: params.responseUrl,
      };
    }

    if (params.reqId !== undefined) {
      return {
        channel: "aibot",
        mode: "ws_respond",
        reqId: params.reqId,
        targetLabel: `req:${params.reqId}`,
      };
    }

    if (params.channel === "aibot") {
      const targetChatId = params.chatId ?? params.toUser;
      if (targetChatId !== undefined) {
        const chatType =
          params.chatId !== undefined ? WECOM_AIBOT_CHAT_TYPE_GROUP : WECOM_AIBOT_CHAT_TYPE_SINGLE;
        return {
          channel: "aibot",
          mode: "ws_proactive",
          chatId: targetChatId,
          chatType,
          targetLabel: targetChatId,
        };
      }
    }

    if (params.chatId !== undefined) {
      if (this.defaultConversationChannel === "aibot" && params.channel === undefined) {
        return {
          channel: "aibot",
          mode: "ws_proactive",
          chatId: params.chatId,
          chatType: WECOM_AIBOT_CHAT_TYPE_GROUP,
          targetLabel: params.chatId,
        };
      }
      return {
        channel: "appchat",
        chatId: params.chatId,
        targetLabel: params.chatId,
      };
    }

    if (params.toUser !== undefined || params.toParty !== undefined || params.toTag !== undefined) {
      if (
        this.defaultConversationChannel === "aibot" &&
        params.channel === undefined &&
        params.toUser !== undefined &&
        params.toParty === undefined &&
        params.toTag === undefined
      ) {
        return {
          channel: "aibot",
          mode: "ws_proactive",
          chatId: params.toUser,
          chatType: WECOM_AIBOT_CHAT_TYPE_SINGLE,
          targetLabel: params.toUser,
        };
      }
      const label = [params.toUser, params.toParty, params.toTag]
        .filter((v): v is string => v !== undefined)
        .join("|");
      return {
        channel: "app",
        ...(params.toUser !== undefined ? { toUser: params.toUser } : {}),
        ...(params.toParty !== undefined ? { toParty: params.toParty } : {}),
        ...(params.toTag !== undefined ? { toTag: params.toTag } : {}),
        targetLabel: label,
      };
    }

    // Tier 2: Structured business target from `context.contextId`
    const parsedContext = parseWeComContextTarget(
      context.contextId,
      this.defaultConversationChannel,
    );
    if (parsedContext !== undefined) {
      if (parsedContext.channel === "webhook") {
        return {
          channel: "webhook",
          webhookKey: parsedContext.targetId,
          targetLabel: `webhook:${parsedContext.targetId}`,
        };
      }

      if (parsedContext.channel === "app") {
        if (parsedContext.peerKind === "group") {
          return {
            channel: "appchat",
            chatId: parsedContext.targetId,
            targetLabel: parsedContext.targetId,
          };
        }
        return {
          channel: "app",
          toUser: parsedContext.targetId,
          targetLabel: parsedContext.targetId,
        };
      }

      // `aibot` context: check single-use HTTP `response_url` cache first, then WebSocket proactive
      const cachedResponseUrl = this.consumeCachedResponseUrl?.(context.contextId);
      if (cachedResponseUrl !== undefined) {
        return {
          channel: "aibot",
          mode: "response_url",
          responseUrl: cachedResponseUrl,
          targetLabel: parsedContext.targetId,
        };
      }

      return {
        channel: "aibot",
        mode: "ws_proactive",
        chatId: parsedContext.targetId,
        chatType:
          parsedContext.peerKind === "group"
            ? WECOM_AIBOT_CHAT_TYPE_GROUP
            : WECOM_AIBOT_CHAT_TYPE_SINGLE,
        targetLabel: parsedContext.targetId,
      };
    }

    // Message-scoped context ids (`msg:…` or an extracted marker) are not chat ids.
    // A single-use Intelligent Bot response_url cached for this exact context is still a route.
    const cachedResponseUrl = this.consumeCachedResponseUrl?.(context.contextId);
    if (cachedResponseUrl !== undefined) {
      return {
        channel: "aibot",
        mode: "response_url",
        responseUrl: cachedResponseUrl,
        targetLabel: context.contextId,
      };
    }

    // Tier 3: Explicit target required error
    throw new ConnectorTargetRequiredError(this.connectorName, "toUser | chatId | webhookKey");
  }

  private async deliverApp(
    plan: Extract<ResolvedOutboundPlan, { readonly channel: "app" }>,
    fullContent: string,
    params: WeComSendParams,
    options?: ConnectorSendOptions,
  ): Promise<WeComSendResult> {
    const format: "text" | "markdown" = params.format === "markdown" ? "markdown" : "text";
    const chunks = splitUtf8ByBytes(fullContent, WECOM_APP_TEXT_MAX_BYTES);
    let lastResponse: WeComApiResponse | undefined;

    for (const chunk of chunks) {
      const recipients = {
        ...(plan.toUser !== undefined ? { touser: plan.toUser } : {}),
        ...(plan.toParty !== undefined ? { toparty: plan.toParty } : {}),
        ...(plan.toTag !== undefined ? { totag: plan.toTag } : {}),
      };
      lastResponse =
        format === "markdown"
          ? await this.apiClient.sendAppMessage(
              {
                ...recipients,
                msgtype: "markdown",
                markdown: { content: chunk },
              },
              options,
            )
          : await this.apiClient.sendAppMessage(
              {
                ...recipients,
                msgtype: "text",
                text: { content: chunk },
                ...(params.safe === true ? { safe: 1 as const } : {}),
              },
              options,
            );
    }

    return this.buildApiSendResult("app", plan.targetLabel, chunks.length, lastResponse!);
  }

  private async deliverAppChat(
    chatId: string,
    targetLabel: string,
    fullContent: string,
    params: WeComSendParams,
    options?: ConnectorSendOptions,
  ): Promise<WeComSendResult> {
    const format: "text" | "markdown" = params.format === "markdown" ? "markdown" : "text";
    const chunks = splitUtf8ByBytes(fullContent, WECOM_APP_TEXT_MAX_BYTES);
    let lastResponse: WeComApiResponse | undefined;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      lastResponse =
        format === "markdown"
          ? await this.apiClient.sendAppChatMessage(
              {
                chatid: chatId,
                msgtype: "markdown",
                markdown: { content: chunk },
              },
              options,
            )
          : await this.apiClient.sendAppChatMessage(
              {
                chatid: chatId,
                msgtype: "text",
                text: {
                  content: chunk,
                  ...(index === 0 && params.mentionedList !== undefined
                    ? { mentioned_list: params.mentionedList }
                    : {}),
                },
                ...(params.safe === true ? { safe: 1 as const } : {}),
              },
              options,
            );
    }

    return this.buildApiSendResult("appchat", targetLabel, chunks.length, lastResponse!);
  }

  private async deliverWebhook(
    webhookKey: string,
    targetLabel: string,
    fullContent: string,
    params: WeComSendParams,
    options?: ConnectorSendOptions,
  ): Promise<WeComSendResult> {
    const format: WeComMessageFormat = params.format ?? "text";
    const maxBytes =
      format === "text" ? WECOM_WEBHOOK_TEXT_MAX_BYTES : WECOM_WEBHOOK_MARKDOWN_MAX_BYTES;
    const chunks = splitUtf8ByBytes(fullContent, maxBytes);
    let lastResponse: WeComApiResponse | undefined;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      if (format === "markdown") {
        lastResponse = await this.apiClient.sendWebhookMessage(
          webhookKey,
          { msgtype: "markdown", markdown: { content: chunk } },
          options,
        );
      } else if (format === "markdown_v2") {
        lastResponse = await this.apiClient.sendWebhookMessage(
          webhookKey,
          { msgtype: "markdown_v2", markdown_v2: { content: chunk } },
          options,
        );
      } else {
        lastResponse = await this.apiClient.sendWebhookMessage(
          webhookKey,
          {
            msgtype: "text",
            text: {
              content: chunk,
              ...(index === 0 && params.mentionedList !== undefined
                ? { mentioned_list: params.mentionedList }
                : {}),
              ...(index === 0 && params.mentionedMobileList !== undefined
                ? { mentioned_mobile_list: params.mentionedMobileList }
                : {}),
            },
          },
          options,
        );
      }
    }

    return this.buildApiSendResult("webhook", targetLabel, chunks.length, lastResponse!);
  }

  private async deliverAibot(
    plan: Extract<ResolvedOutboundPlan, { readonly channel: "aibot" }>,
    fullContent: string,
    options?: ConnectorSendOptions,
  ): Promise<WeComSendResult> {
    const chunks = splitUtf8ByBytes(fullContent, WECOM_AIBOT_MARKDOWN_MAX_BYTES);

    if (plan.mode === "response_url") {
      if (chunks.length > 1) {
        throw new ConnectorValidationError(
          `WeCom Intelligent Bot response_url supports a single message <= ${WECOM_AIBOT_MARKDOWN_MAX_BYTES} UTF-8 bytes.`,
          { connectorName: this.connectorName },
        );
      }
      const response = await this.apiClient.sendResponseUrlMessage(
        plan.responseUrl,
        {
          msgtype: "markdown",
          markdown: { content: chunks[0]! },
        },
        options,
      );
      return this.buildApiSendResult("aibot", plan.targetLabel, 1, response);
    }

    if (this.aibotTransport === undefined || !this.aibotTransport.isConnected()) {
      throw new ConnectorTransportError(
        `Connector "${this.connectorName}" Intelligent Bot WebSocket transport is not connected.`,
        { connectorName: this.connectorName, retryable: true },
      );
    }

    let lastAck:
      | { readonly reqId: string; readonly raw: Readonly<Record<string, unknown>> }
      | undefined;
    for (const chunk of chunks) {
      if (plan.mode === "ws_respond") {
        lastAck = await this.aibotTransport.respondMarkdown(
          { reqId: plan.reqId, content: chunk },
          options,
        );
      } else {
        lastAck = await this.aibotTransport.sendProactiveMarkdown(
          { chatId: plan.chatId, chatType: plan.chatType, content: chunk },
          options,
        );
      }
    }

    return {
      externalId: lastAck!.reqId,
      reqId: lastAck!.reqId,
      channel: "aibot",
      target: plan.targetLabel,
      chunkCount: chunks.length,
      summary: `Delivered ${chunks.length} WeCom message(s) via aibot to ${plan.targetLabel}.`,
      raw: lastAck!.raw,
      data: {
        channel: "aibot",
        target: plan.targetLabel,
        chunkCount: chunks.length,
        reqId: lastAck!.reqId,
      },
    };
  }

  private buildApiSendResult(
    channel: WeComOutboundChannel,
    target: string,
    chunkCount: number,
    rawResponse: WeComApiResponse,
  ): WeComSendResult {
    const messageId =
      typeof rawResponse.msgid === "string" && rawResponse.msgid.length > 0
        ? rawResponse.msgid
        : undefined;
    const responseCode =
      typeof rawResponse.response_code === "string" && rawResponse.response_code.length > 0
        ? rawResponse.response_code
        : undefined;

    return {
      ...(messageId !== undefined ? { externalId: messageId, messageId } : {}),
      ...(responseCode !== undefined ? { responseCode } : {}),
      channel,
      target,
      chunkCount,
      summary: `Delivered ${chunkCount} WeCom message(s) via ${channel} to ${target}.`,
      raw: rawResponse,
      data: {
        channel,
        target,
        chunkCount,
        ...(messageId !== undefined ? { messageId } : {}),
        ...(responseCode !== undefined ? { responseCode } : {}),
      },
    };
  }
}
