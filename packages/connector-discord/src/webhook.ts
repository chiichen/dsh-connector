/**
 * Discord Interactions HTTP Webhook handler (`POST` + Ed25519 signature verification + PING/Command/Component/Modal routing).
 *
 * @see https://discord.com/developers/docs/interactions/overview#setting-up-an-endpoint
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-response-object
 */

import {
  createConnectorContext,
  extractContextMarker,
  resolveInboundContextId,
  type ConnectorReceiverContext,
  type ConnectorWebhookRequest,
  type ConnectorWebhookResponse,
} from "@dsh-connector/core";
import {
  DISCORD_DIRECT_CHANNEL_TYPES,
  DISCORD_IDEMPOTENCY_PREFIX_INTERACTION,
  DISCORD_INTERACTION_CALLBACK_TYPES,
  DISCORD_INTERACTION_TYPES,
  DISCORD_THREAD_CHANNEL_TYPES,
  HTTP_STATUS_ACCEPTED,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_OK,
  HTTP_STATUS_UNAUTHORIZED,
} from "./constants";
import { isDiscordSnowflake } from "./context-target";
import { verifyDiscordInteractionHeaders } from "./signature";
import type {
  DiscordInteraction,
  DiscordInteractionOption,
  DiscordModalComponentChild,
  DiscordReceiveEvent,
  discordReceiveSchema,
} from "./types";

const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
});

export interface DiscordInteractionWebhookOptions<TName extends string = "discord"> {
  readonly connectorName: TName;
  readonly publicKey?: string;
  readonly botUserId?: string;
  readonly ignoreBotMessages: boolean;
  readonly deferredCallbackType?: number;
  readonly receiverContext?: ConnectorReceiverContext<typeof discordReceiveSchema, TName>;
}

function jsonResponse(status: number, payload: Record<string, unknown>): ConnectorWebhookResponse {
  return {
    status,
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatInteractionOptions(
  options: readonly DiscordInteractionOption[] | undefined,
): string {
  if (!options || options.length === 0) {
    return "";
  }
  const parts: string[] = [];
  for (const opt of options) {
    if (opt.options && opt.options.length > 0) {
      const nested = formatInteractionOptions(opt.options);
      parts.push(`${opt.name} ${nested}`);
    } else if (opt.value !== undefined) {
      parts.push(`${opt.name}: ${String(opt.value)}`);
    } else {
      parts.push(opt.name);
    }
  }
  return parts.join(" ");
}

function formatKeyedValue(key: string | undefined, value: string): string {
  return key ? `${key}: ${value}` : value;
}

function extractModalValues(groups: readonly DiscordModalComponentChild[] | undefined): string {
  const lines: string[] = [];
  for (const row of groups ?? []) {
    if (typeof row.value === "string" && row.value.trim()) {
      lines.push(formatKeyedValue(row.custom_id, row.value.trim()));
    }
    if (row.components) {
      for (const field of row.components) {
        if (typeof field.value === "string" && field.value.trim()) {
          lines.push(formatKeyedValue(field.custom_id, field.value.trim()));
        } else if (field.values && field.values.length > 0) {
          lines.push(formatKeyedValue(field.custom_id, field.values.join(", ")));
        }
      }
    }
  }
  return lines.join("\n");
}

function extractInteractionText(interaction: DiscordInteraction): string {
  const data = interaction.data;
  if (!data) {
    return `interaction:${interaction.id}`;
  }

  if (interaction.type === DISCORD_INTERACTION_TYPES.APPLICATION_COMMAND) {
    const commandName = data.name?.trim() || "command";
    const optsText = formatInteractionOptions(data.options);
    return optsText ? `/${commandName} ${optsText}` : `/${commandName}`;
  }

  if (interaction.type === DISCORD_INTERACTION_TYPES.MESSAGE_COMPONENT) {
    const customId = data.custom_id?.trim() || "component";
    const selected = data.values && data.values.length > 0 ? `: ${data.values.join(", ")}` : "";
    return `[component:${customId}]${selected}`;
  }

  const customId = data.custom_id?.trim() || "modal";
  const modalText = extractModalValues(data.components);
  return modalText ? `[modal:${customId}]\n${modalText}` : `[modal:${customId}]`;
}

/**
 * Verifies and processes an incoming Discord Interactions HTTP Webhook request.
 *
 * - Rejects non-`POST` methods with HTTP `405`
 * - Verifies `X-Signature-Ed25519` + `X-Signature-Timestamp` against `rawBody` (`401` on failure)
 * - Responds to `PING` (`type: 1`) with `200` `{"type":1}` (`PONG`)
 * - Dispatches `APPLICATION_COMMAND` (`2`), `MESSAGE_COMPONENT` (`3`), and `MODAL_SUBMIT` (`5`)
 *   to `receiverContext.onReceive` and acknowledges with `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` (`type: 5`)
 *
 * @see https://discord.com/developers/docs/interactions/overview#setting-up-an-endpoint
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding#receiving-an-interaction
 */
export async function handleDiscordInteractionWebhook<TName extends string = "discord">(
  req: ConnectorWebhookRequest,
  options: DiscordInteractionWebhookOptions<TName>,
): Promise<ConnectorWebhookResponse> {
  if (req.method.toUpperCase() !== "POST") {
    return jsonResponse(HTTP_STATUS_METHOD_NOT_ALLOWED, {
      error: "Method Not Allowed",
    });
  }

  const publicKey = options.publicKey?.trim();
  if (!publicKey) {
    return jsonResponse(HTTP_STATUS_UNAUTHORIZED, {
      error: "Discord interaction publicKey is not configured",
    });
  }

  const verified = verifyDiscordInteractionHeaders({
    publicKeyHex: publicKey,
    headers: req.headers,
    rawBody: req.rawBody,
  });
  if (!verified) {
    return jsonResponse(HTTP_STATUS_UNAUTHORIZED, {
      error: "Invalid request signature",
    });
  }

  let parsedUnknown: unknown;
  try {
    const bodyText = new TextDecoder().decode(req.rawBody);
    parsedUnknown = JSON.parse(bodyText);
  } catch {
    return jsonResponse(HTTP_STATUS_BAD_REQUEST, {
      error: "Malformed JSON body",
    });
  }

  if (!isPlainRecord(parsedUnknown) || typeof parsedUnknown["type"] !== "number") {
    return jsonResponse(HTTP_STATUS_BAD_REQUEST, {
      error: "Invalid Discord interaction payload",
    });
  }

  const interactionType = parsedUnknown["type"];
  if (interactionType === DISCORD_INTERACTION_TYPES.PING) {
    return jsonResponse(HTTP_STATUS_OK, {
      type: DISCORD_INTERACTION_CALLBACK_TYPES.PONG,
    });
  }

  if (
    typeof parsedUnknown["id"] !== "string" ||
    !isDiscordSnowflake(parsedUnknown["id"]) ||
    typeof parsedUnknown["application_id"] !== "string" ||
    typeof parsedUnknown["token"] !== "string"
  ) {
    return jsonResponse(HTTP_STATUS_BAD_REQUEST, {
      error: "Missing required Discord interaction fields (id, application_id, token)",
    });
  }

  const interaction = parsedUnknown as unknown as DiscordInteraction;

  if (
    interaction.type !== DISCORD_INTERACTION_TYPES.APPLICATION_COMMAND &&
    interaction.type !== DISCORD_INTERACTION_TYPES.MESSAGE_COMPONENT &&
    interaction.type !== DISCORD_INTERACTION_TYPES.MODAL_SUBMIT
  ) {
    return jsonResponse(HTTP_STATUS_ACCEPTED, {
      accepted: false,
      reason: `Unsupported interaction type ${String(interaction.type)}`,
    });
  }

  const invokingUser = interaction.member?.user ?? interaction.user;
  if (!invokingUser || !isDiscordSnowflake(invokingUser.id)) {
    return jsonResponse(HTTP_STATUS_BAD_REQUEST, {
      error: "Missing invoking user on Discord interaction",
    });
  }

  if (
    (options.botUserId && invokingUser.id === options.botUserId) ||
    (options.ignoreBotMessages && invokingUser.bot === true)
  ) {
    return jsonResponse(HTTP_STATUS_ACCEPTED, {
      accepted: false,
      reason: "Ignored bot interaction",
    });
  }

  if (!options.receiverContext) {
    return jsonResponse(HTTP_STATUS_INTERNAL_SERVER_ERROR, {
      error: "Discord receiver is not initialized",
    });
  }

  const channelId = interaction.channel?.id ?? interaction.channel_id;
  if (!channelId || !isDiscordSnowflake(channelId)) {
    return jsonResponse(HTTP_STATUS_BAD_REQUEST, {
      error: "Missing channel_id on Discord interaction",
    });
  }

  const channelType = interaction.channel?.type;
  const isDirectMessage =
    !interaction.guild_id ||
    (channelType !== undefined && DISCORD_DIRECT_CHANNEL_TYPES.has(channelType));
  const isThread =
    !isDirectMessage && channelType !== undefined && DISCORD_THREAD_CHANNEL_TYPES.has(channelType);
  const parentChannelId = interaction.channel?.parent_id ?? undefined;

  const rawPromptText = extractInteractionText(interaction);
  const msgMarker = interaction.message?.content
    ? extractContextMarker(interaction.message.content)
    : undefined;
  const promptMarker = extractContextMarker(rawPromptText);

  const cleanedText = promptMarker.cleanedContent.trim();
  const context = createConnectorContext(
    options.connectorName,
    resolveInboundContextId({
      messageId: interaction.id,
      body: rawPromptText,
      quotedTexts: [interaction.message?.content],
    }),
  );

  const authorName =
    interaction.member?.nick?.trim() || invokingUser.global_name?.trim() || invokingUser.username;

  const receiveEvent: DiscordReceiveEvent = {
    source: "interaction-webhook",
    eventId: interaction.id,
    channelId,
    guildId: interaction.guild_id,
    threadId: isThread ? channelId : undefined,
    parentChannelId: isThread ? parentChannelId : undefined,
    authorId: invokingUser.id,
    authorName,
    text: cleanedText,
    rawContent: rawPromptText,
    isDirectMessage,
    isThread,
    mentionedBot: true,
    replyToMessageId: interaction.message?.id,
    referencedText: msgMarker ? msgMarker.cleanedContent : interaction.message?.content,
    attachments: [],
    timestamp: new Date().toISOString(),
    interactionToken: interaction.token,
    applicationId: interaction.application_id,
    interactionType: interaction.type,
    commandName: interaction.data?.name,
    customId: interaction.data?.custom_id,
  };

  await options.receiverContext.onReceive(context, receiveEvent, {
    idempotencyKey: `${DISCORD_IDEMPOTENCY_PREFIX_INTERACTION}${interaction.id}`,
    receivedAt: Date.now(),
    suggestedTitle: interaction.data?.name
      ? `Discord /${interaction.data.name} (${authorName})`
      : `Discord (${authorName})`,
  });

  const callbackType =
    options.deferredCallbackType ??
    (interaction.type === DISCORD_INTERACTION_TYPES.MESSAGE_COMPONENT
      ? DISCORD_INTERACTION_CALLBACK_TYPES.DEFERRED_UPDATE_MESSAGE
      : DISCORD_INTERACTION_CALLBACK_TYPES.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);

  return jsonResponse(HTTP_STATUS_OK, {
    type: callbackType,
  });
}
