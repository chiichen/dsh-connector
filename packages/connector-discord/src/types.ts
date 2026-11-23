/**
 * Strongly typed Discord API v10 data models, Zod send/receive schemas, and transport abstractions.
 *
 * @see https://discord.com/developers/docs/resources/message
 * @see https://discord.com/developers/docs/resources/channel
 * @see https://discord.com/developers/docs/resources/user
 * @see https://discord.com/developers/docs/events/gateway-events
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding
 */

import type { ConnectorSendResult } from "@dsh-connector/core";
import { z } from "zod";

/**
 * Discord User object subset.
 * @see https://discord.com/developers/docs/resources/user#user-object
 */
export interface DiscordUser {
  readonly id: string;
  readonly username: string;
  readonly discriminator?: string;
  readonly global_name?: string | null;
  readonly avatar?: string | null;
  readonly bot?: boolean;
  readonly system?: boolean;
}

/**
 * Partial Guild Member object included on Gateway / Interaction payloads.
 * @see https://discord.com/developers/docs/resources/guild#guild-member-object
 */
export interface DiscordGuildMember {
  readonly user?: DiscordUser;
  readonly nick?: string | null;
  readonly roles?: readonly string[];
}

/**
 * Discord Thread Metadata object.
 * @see https://discord.com/developers/docs/resources/channel#thread-metadata-object
 */
export interface DiscordThreadMetadata {
  readonly archived: boolean;
  readonly auto_archive_duration: number;
  readonly archive_timestamp: string;
  readonly locked: boolean;
  readonly invitable?: boolean;
}

/**
 * Discord Channel / Thread object subset.
 * @see https://discord.com/developers/docs/resources/channel#channel-object
 */
export interface DiscordChannel {
  readonly id: string;
  readonly type: number;
  readonly guild_id?: string;
  readonly name?: string | null;
  readonly parent_id?: string | null;
  readonly owner_id?: string;
  readonly recipients?: readonly DiscordUser[];
  readonly thread_metadata?: DiscordThreadMetadata;
}

/**
 * Discord Allowed Mentions structure.
 * @see https://discord.com/developers/docs/resources/message#allowed-mentions-object
 */
export type DiscordAllowedMentionType = "roles" | "users" | "everyone";

export interface DiscordAllowedMentions {
  readonly parse?: readonly DiscordAllowedMentionType[];
  readonly roles?: readonly string[];
  readonly users?: readonly string[];
  readonly replied_user?: boolean;
}

/**
 * Discord Message Reference structure (`message_reference`).
 * @see https://discord.com/developers/docs/resources/message#message-reference-object
 */
export interface DiscordMessageReference {
  readonly type?: number;
  readonly message_id?: string;
  readonly channel_id?: string;
  readonly guild_id?: string;
  readonly fail_if_not_exists?: boolean;
}

/**
 * Discord Attachment object subset.
 * @see https://discord.com/developers/docs/resources/message#attachment-object
 */
export interface DiscordAttachment {
  readonly id: string;
  readonly filename: string;
  readonly content_type?: string;
  readonly size: number;
  readonly url: string;
  readonly proxy_url?: string;
  readonly description?: string;
}

/**
 * Discord Embed object subset.
 * @see https://discord.com/developers/docs/resources/message#embed-object
 */
export interface DiscordEmbedField {
  readonly name: string;
  readonly value: string;
  readonly inline?: boolean;
}

export interface DiscordEmbed {
  readonly title?: string;
  readonly type?: string;
  readonly description?: string;
  readonly url?: string;
  readonly timestamp?: string;
  readonly color?: number;
  readonly footer?: { readonly text: string; readonly icon_url?: string };
  readonly author?: {
    readonly name: string;
    readonly url?: string;
    readonly icon_url?: string;
  };
  readonly fields?: readonly DiscordEmbedField[];
}

/**
 * Discord Message object (`MESSAGE_CREATE` & REST v10 Message endpoints).
 * @see https://discord.com/developers/docs/resources/message#message-object
 * @see https://discord.com/developers/docs/events/gateway-events#message-create
 */
export interface DiscordApiMessage {
  readonly id: string;
  readonly channel_id: string;
  readonly guild_id?: string;
  readonly channel_type?: number;
  readonly author: DiscordUser;
  readonly member?: DiscordGuildMember;
  readonly content: string;
  readonly timestamp: string;
  readonly edited_timestamp?: string | null;
  readonly tts?: boolean;
  readonly mention_everyone?: boolean;
  readonly mentions?: readonly DiscordUser[];
  readonly mention_roles?: readonly string[];
  readonly attachments?: readonly DiscordAttachment[];
  readonly embeds?: readonly DiscordEmbed[];
  readonly webhook_id?: string;
  readonly type: number;
  readonly flags?: number;
  readonly message_reference?: DiscordMessageReference;
  readonly referenced_message?: DiscordApiMessage | null;
  readonly thread?: DiscordChannel;
}

/**
 * `GET /gateway/bot` response structure.
 * @see https://discord.com/developers/docs/events/gateway#get-gateway-bot
 */
export interface DiscordSessionStartLimit {
  readonly total: number;
  readonly remaining: number;
  readonly reset_after: number;
  readonly max_concurrency: number;
}

export interface DiscordGatewayBotResponse {
  readonly url: string;
  readonly shards?: number;
  readonly session_start_limit?: DiscordSessionStartLimit;
}

/**
 * Gateway event envelope (`op`, `d`, `s`, `t`).
 * @see https://discord.com/developers/docs/events/gateway-events#payload-structure
 */
export interface DiscordGatewayPacket<TData = unknown> {
  readonly op: number;
  readonly d?: TData;
  readonly s?: number | null;
  readonly t?: string | null;
}

/**
 * Gateway `READY` dispatch data.
 * @see https://discord.com/developers/docs/events/gateway-events#ready
 */
export interface DiscordGatewayReadyData {
  readonly v: number;
  readonly user: DiscordUser;
  readonly session_id: string;
  readonly resume_gateway_url: string;
  readonly shard?: readonly [number, number];
  readonly application?: {
    readonly id: string;
    readonly flags?: number;
  };
}

/**
 * Discord Interaction option / component / modal structures.
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object
 */
export interface DiscordInteractionOption {
  readonly name: string;
  readonly type: number;
  readonly value?: string | number | boolean;
  readonly options?: readonly DiscordInteractionOption[];
  readonly focused?: boolean;
}

export interface DiscordModalComponentChild {
  readonly type: number;
  readonly custom_id?: string;
  readonly value?: string;
  readonly values?: readonly string[];
  readonly components?: readonly DiscordModalComponentChild[];
}

export interface DiscordInteractionData {
  readonly id?: string;
  readonly name?: string;
  readonly type?: number;
  readonly custom_id?: string;
  readonly component_type?: number;
  readonly values?: readonly string[];
  readonly options?: readonly DiscordInteractionOption[];
  readonly components?: readonly DiscordModalComponentChild[];
  readonly target_id?: string;
}

export interface DiscordInteraction {
  readonly id: string;
  readonly application_id: string;
  readonly type: number;
  readonly token: string;
  readonly version?: number;
  readonly guild_id?: string;
  readonly channel_id?: string;
  readonly channel?: DiscordChannel;
  readonly member?: DiscordGuildMember;
  readonly user?: DiscordUser;
  readonly data?: DiscordInteractionData;
  readonly message?: DiscordApiMessage;
}

/**
 * Minimal injectable WebSocket interface compatible with Node.js 24 native `WebSocket`
 * and deterministic test doubles.
 */
export interface WebSocketMessageEventLike {
  readonly data: string | ArrayBuffer | Uint8Array;
}

export interface WebSocketCloseEventLike {
  readonly code?: number;
  readonly reason?: string;
}

export interface WebSocketErrorEventLike {
  readonly error?: unknown;
  readonly message?: string;
}

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: WebSocketMessageEventLike) => void): void;
  addEventListener(type: "close", listener: (event: WebSocketCloseEventLike) => void): void;
  addEventListener(type: "error", listener: (event: WebSocketErrorEventLike) => void): void;
}

export type CreateWebSocketFn = (url: string) => WebSocketLike;

/**
 * Resolved Discord outbound target discriminated union.
 */
export type DiscordResolvedTarget =
  | {
      readonly kind: "dm";
      readonly channelId: string;
    }
  | {
      readonly kind: "user";
      readonly userId: string;
    }
  | {
      readonly kind: "channel";
      readonly channelId: string;
    }
  | {
      readonly kind: "thread";
      readonly channelId: string;
      readonly threadId: string;
      readonly parentChannelId?: string;
    };

/**
 * Outbound `sender.schema` following the unified `text` primary field contract.
 * All target addressing fields are optional so `send()` resolves `params > context.contextId > ConnectorTargetRequiredError`.
 *
 * @see https://discord.com/developers/docs/resources/message#create-message
 */
export const discordSendSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe("Message content to send to Discord (auto-chunked at 2000 chars)."),
  channelId: z
    .string()
    .min(1)
    .optional()
    .describe("Optional Discord channel ID (guild text channel, DM channel, or thread channel)."),
  threadId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional Discord thread channel ID. Takes precedence over channelId when posting into a thread.",
    ),
  userId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional Discord user ID to open/send a Direct Message via POST /users/@me/channels.",
    ),
  replyToMessageId: z
    .string()
    .min(1)
    .optional()
    .describe("Optional Discord message ID to reply to via message_reference."),
  includeContextMarker: z
    .boolean()
    .optional()
    .describe(
      "Optional override to prepend a [#ctx:<contextId>] correlation marker to the message.",
    ),
});

export type DiscordSendParams = z.output<typeof discordSendSchema>;

/**
 * Inbound `receiver.schema` covering both Gateway `MESSAGE_CREATE` and HTTP Interactions.
 *
 * @see https://discord.com/developers/docs/events/gateway-events#message-create
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding
 */
export const discordReceiveSourceSchema = z.enum(["gateway-message", "interaction-webhook"]);

export const discordReceiveSchema = z.object({
  source: discordReceiveSourceSchema,
  eventId: z.string().min(1),
  channelId: z.string().min(1),
  guildId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  parentChannelId: z.string().min(1).optional(),
  authorId: z.string().min(1),
  authorName: z.string().min(1),
  text: z.string(),
  isDirectMessage: z.boolean(),
  isThread: z.boolean(),
  replyToMessageId: z.string().min(1).optional(),
  referencedText: z.string().optional(),
  interactionToken: z.string().min(1).optional(),
  applicationId: z.string().min(1).optional(),
  interactionType: z.number().int().optional(),
  commandName: z.string().min(1).optional(),
  customId: z.string().min(1).optional(),
  timestamp: z.string().min(1),
});

export type DiscordReceiveEvent = z.output<typeof discordReceiveSchema>;

/**
 * Structured `ConnectorSendResult` retaining Discord platform handles (`messageId`, `channelId`, `threadId`, `raw`)
 * required for subsequent in-place message editing or streaming continuation.
 *
 * @see https://discord.com/developers/docs/resources/message#edit-message
 */
export interface DiscordSendResult extends ConnectorSendResult {
  readonly externalId: string;
  readonly messageId: string;
  readonly messageIds: readonly string[];
  readonly channelId: string;
  readonly threadId?: string;
  readonly summary: string;
  readonly raw: readonly DiscordApiMessage[];
  readonly data: {
    readonly messageId: string;
    readonly messageIds: readonly string[];
    readonly channelId: string;
    readonly threadId?: string;
  };
}
