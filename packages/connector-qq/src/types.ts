import { z } from "zod";
import type { ConnectorSendResult } from "@dsh-connector/core";
import {
  QQ_EVENT_AT_MESSAGE_CREATE,
  QQ_EVENT_C2C_MESSAGE_CREATE,
  QQ_EVENT_GROUP_AT_MESSAGE_CREATE,
} from "./constants";

/**
 * Supported QQ Official Bot conversation scenes.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html
 */
export const qqSceneSchema = z.enum(["c2c", "group", "channel"]);
export type QqScene = z.infer<typeof qqSceneSchema>;

export const qqMessageFormatSchema = z.enum(["plain", "markdown"]);
export type QqMessageFormat = z.infer<typeof qqMessageFormatSchema>;

/**
 * Resolved QQ target descriptor across C2C, group, and guild channel scenes.
 */
export type QqTarget =
  | {
      readonly scene: "c2c";
      readonly openId: string;
    }
  | {
      readonly scene: "group";
      readonly groupOpenId: string;
    }
  | {
      readonly scene: "channel";
      readonly channelId: string;
      readonly guildId?: string;
    };

/**
 * Outbound send schema for `@dsh-connector/connector-qq`.
 * Primary message body uses `text` for seamless host compatibility, while all
 * target addressing fields remain optional so `send()` can fall back to `context.contextId`.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/send.html
 */
export const qqSendSchema = z.object({
  text: z.string().min(1).describe("Message content to send to QQ user, group, or channel"),
  scene: qqSceneSchema
    .optional()
    .describe("Optional explicit target scene: c2c, group, or channel"),
  openId: z
    .string()
    .min(1)
    .optional()
    .describe("C2C recipient user_openid (sends via /v2/users/{openid}/messages)"),
  groupOpenId: z
    .string()
    .min(1)
    .optional()
    .describe("QQ group group_openid (sends via /v2/groups/{group_openid}/messages)"),
  channelId: z
    .string()
    .min(1)
    .optional()
    .describe("QQ guild sub-channel channel_id (sends via /channels/{channel_id}/messages)"),
  replyToMessageId: z
    .string()
    .min(1)
    .optional()
    .describe("Passive reply source message ID (msg_id)"),
  eventId: z
    .string()
    .min(1)
    .optional()
    .describe("Passive reply source event ID (event_id, mutually exclusive with msg_id)"),
  msgSeq: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Explicit msg_seq sequence number when replying with msg_id"),
  format: qqMessageFormatSchema
    .optional()
    .describe("Message format: plain (msg_type=0) or markdown (msg_type=2)"),
  includeContextMarker: z
    .boolean()
    .optional()
    .describe("Whether to prepend compact [#ctx:...] correlation marker to outbound text"),
});

export type QqSendParams = z.output<typeof qqSendSchema>;
export type QqSendInput = z.input<typeof qqSendSchema>;

export const qqInboundEventTypeSchema = z.enum([
  QQ_EVENT_C2C_MESSAGE_CREATE,
  QQ_EVENT_GROUP_AT_MESSAGE_CREATE,
  QQ_EVENT_AT_MESSAGE_CREATE,
]);
export type QqInboundEventType = z.infer<typeof qqInboundEventTypeSchema>;

export const qqAttachmentSchema = z.object({
  url: z.string().optional(),
  filename: z.string().optional(),
  contentType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type QqInboundAttachmentMeta = z.infer<typeof qqAttachmentSchema>;

/**
 * Normalized inbound message payload delivered to `onReceive`.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/event.html
 */
export const qqReceiveSchema = z.object({
  eventType: qqInboundEventTypeSchema,
  scene: qqSceneSchema,
  messageId: z.string().min(1),
  eventId: z.string().optional(),
  text: z.string(),
  rawContent: z.string().optional(),
  quotedContent: z.string().optional(),
  senderId: z.string().min(1),
  senderName: z.string().optional(),
  openId: z.string().optional(),
  groupOpenId: z.string().optional(),
  guildId: z.string().optional(),
  channelId: z.string().optional(),
  msgIdx: z.string().optional(),
  refMsgIdx: z.string().optional(),
  timestamp: z.string().optional(),
  attachments: z.array(qqAttachmentSchema).optional(),
});

export type QqInboundMessage = z.output<typeof qqReceiveSchema>;
export type QqInboundMessageInput = z.input<typeof qqReceiveSchema>;

/**
 * Raw response returned by QQ OpenAPI message send endpoints.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/send.html
 */
export interface QqRawSendResponse {
  readonly id?: string;
  readonly timestamp?: string;
  readonly ext_info?: {
    readonly ref_idx?: string;
  };
  readonly code?: number;
  readonly message?: string;
  readonly data?: {
    readonly message_audit?: {
      readonly audit_id?: string;
    };
  };
}

/**
 * Structured send result preserving message handles (`messageId`, `target`, `passiveMsgId`,
 * `msgSeq`, `refIdx`, `raw`) required for follow-up passive `msg_seq` continuation,
 * withdrawal, or future streaming extensions.
 */
export interface QqSendResult extends ConnectorSendResult {
  readonly messageId: string;
  readonly target: QqTarget;
  readonly passiveMsgId?: string;
  readonly msgSeq?: number;
  readonly refIdx?: string;
  readonly timestamp?: string;
  readonly auditId?: string;
  readonly raw: QqRawSendResponse;
}
