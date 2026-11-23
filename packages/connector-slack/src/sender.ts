import { z } from "zod";
import {
  prependContextMarker,
  type ConnectorContext,
  type ConnectorSender,
  type ConnectorSendOptions,
  type ConnectorSendResult,
  type ContextMarkerStyle,
} from "@dsh-connector/core";
import type { SlackApiClient } from "./api-client";
import { SLACK_TEXT_MAX_LENGTH } from "./constants";
import { resolveSlackSendTarget } from "./context-target";

/**
 * Outbound send schema for Slack (`connector_send_<name>`).
 * Uses `text` as the primary content field per unified IM connector conventions,
 * with all Slack target addressing fields marked `.optional()`.
 *
 * @see https://docs.slack.dev/reference/methods/chat.postMessage/
 */
export const slackSendSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(SLACK_TEXT_MAX_LENGTH)
    .describe("Message text to post to Slack (mrkdwn enabled by default)."),
  channelId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target Slack channel ID (C.../G...), DM ID (D...), or user ID (U...). Optional when sending within an established Slack conversation context.",
    ),
  threadTs: z
    .string()
    .min(1)
    .optional()
    .describe("Parent message timestamp (thread_ts) to post as a threaded reply."),
  replyBroadcast: z
    .boolean()
    .optional()
    .describe("When posting to a thread, whether to also broadcast the reply to the channel."),
  mrkdwn: z.boolean().optional().describe("Enable Slack mrkdwn formatting (defaults to true)."),
});

export type SlackSendParams = z.output<typeof slackSendSchema>;

/**
 * Structured send result returned by `SlackConnector` outbound `send()`.
 * Preserves `channelId`, `messageTs`, and `threadTs` handles so future `chat.update`,
 * `assistant.threads.setStatus`, or `chat.appendStream`/`chat.stopStream` extensions
 * can address the exact message without breaking existing callers.
 *
 * @see https://docs.slack.dev/reference/methods/chat.postMessage/
 * @see https://docs.slack.dev/reference/methods/chat.update
 */
export interface SlackSendResult extends ConnectorSendResult {
  readonly externalId: string;
  readonly summary: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly threadTs?: string;
  readonly data: {
    readonly channelId: string;
    readonly messageTs: string;
    readonly threadTs?: string;
    readonly raw: Readonly<Record<string, unknown>>;
  };
}

export interface CreateSlackSenderOptions<TName extends string = string> {
  readonly connectorName: TName;
  readonly apiClient: SlackApiClient;
  readonly includeContextMarker?: boolean;
  readonly contextMarkerStyle?: ContextMarkerStyle;
  readonly onThreadActive?: (channelId: string, threadTs: string) => void;
}

/**
 * Creates the `ConnectorSender` implementation backed by Slack `chat.postMessage`.
 *
 * @see https://docs.slack.dev/reference/methods/chat.postMessage/
 */
export function createSlackSender<const TName extends string>(
  options: CreateSlackSenderOptions<TName>,
): ConnectorSender<typeof slackSendSchema, SlackSendResult, TName> {
  const markerStyle: ContextMarkerStyle = options.contextMarkerStyle ?? "bracket";

  return {
    description:
      "Send a message or threaded reply to a Slack channel or direct message via chat.postMessage.",
    schema: slackSendSchema,
    async send(
      context: ConnectorContext<TName>,
      params: SlackSendParams,
      sendOptions?: ConnectorSendOptions,
    ): Promise<SlackSendResult> {
      const target = resolveSlackSendTarget(context, {
        channelId: params.channelId,
        threadTs: params.threadTs,
      });

      const wireText =
        options.includeContextMarker === true
          ? prependContextMarker(params.text, context.contextId, markerStyle)
          : params.text;

      const response = await options.apiClient.postMessage(
        {
          channel: target.channelId,
          text: wireText,
          thread_ts: target.threadTs,
          reply_broadcast: params.replyBroadcast,
          mrkdwn: params.mrkdwn,
        },
        { signal: sendOptions?.signal },
      );

      if (target.threadTs !== undefined) {
        options.onThreadActive?.(response.channel, target.threadTs);
      }

      const externalId = `${response.channel}:${response.ts}`;
      const summary =
        target.threadTs !== undefined
          ? `Sent Slack reply to ${response.channel} (thread ${target.threadTs})`
          : `Sent Slack message to ${response.channel}`;

      return {
        externalId,
        summary,
        channelId: response.channel,
        messageTs: response.ts,
        ...(target.threadTs !== undefined ? { threadTs: target.threadTs } : {}),
        data: {
          channelId: response.channel,
          messageTs: response.ts,
          ...(target.threadTs !== undefined ? { threadTs: target.threadTs } : {}),
          raw: {
            ok: response.ok,
            channel: response.channel,
            ts: response.ts,
            ...(response.message !== undefined ? { message: response.message } : {}),
            ...(response.warning !== undefined ? { warning: response.warning } : {}),
          },
        },
      };
    },
  };
}
