import {
  ConnectorTargetRequiredError,
  ConnectorValidationError,
  type ConnectorContext,
  type ConnectorContextId,
} from "@dsh-connector/core";
import {
  SLACK_CONTEXT_CHANNEL_KIND,
  SLACK_CONTEXT_DM_KIND,
  SLACK_CONTEXT_PART_SEPARATOR,
} from "./constants";

const SLACK_CONVERSATION_OR_USER_ID_RE = /^[CDGUW][A-Z0-9]{4,30}$/i;
const SLACK_TIMESTAMP_RE = /^\d+\.\d+$/;
const MIN_CONTEXT_PARTS = 2;
const MAX_CONTEXT_PARTS = 3;

export type SlackConversationKind =
  | typeof SLACK_CONTEXT_DM_KIND
  | typeof SLACK_CONTEXT_CHANNEL_KIND;

/**
 * Structured business target encoded inside a Slack `ConnectorContextId`.
 *
 * - Direct messages: `dm:<channelId>` or `dm:<channelId>:<threadTs>`
 * - Channel / group threads: `channel:<channelId>:<threadTs>` or `channel:<channelId>`
 *
 * @see https://docs.slack.dev/reference/methods/chat.postMessage/
 */
export interface SlackConversationTarget {
  readonly kind: SlackConversationKind;
  readonly channelId: string;
  readonly threadTs?: string;
}

/**
 * Concrete Slack Web API target resolved for an outbound `chat.postMessage` request.
 *
 * @see https://docs.slack.dev/reference/methods/chat.postMessage/
 */
export interface ResolvedSlackSendTarget {
  readonly channelId: string;
  readonly threadTs?: string;
}

export interface SlackSendTargetParams {
  readonly channelId?: string | undefined;
  readonly threadTs?: string | undefined;
}

export function isValidSlackChannelId(value: string): boolean {
  return SLACK_CONVERSATION_OR_USER_ID_RE.test(value.trim());
}

export function isValidSlackTimestamp(value: string): boolean {
  return SLACK_TIMESTAMP_RE.test(value.trim());
}

export function assertValidSlackChannelId(value: string, connectorName?: string): string {
  const trimmed = value.trim();
  if (!isValidSlackChannelId(trimmed)) {
    throw new ConnectorValidationError(
      `Invalid Slack channelId "${value}": expected a Slack conversation or user ID (e.g. C0123456789, D0123456789, G0123456789, U0123456789).`,
      connectorName !== undefined ? { connectorName } : undefined,
    );
  }
  return trimmed;
}

export function assertValidSlackTimestamp(value: string, connectorName?: string): string {
  const trimmed = value.trim();
  if (!isValidSlackTimestamp(trimmed)) {
    throw new ConnectorValidationError(
      `Invalid Slack threadTs "${value}": expected a Slack message timestamp such as "1717171717.123456".`,
      connectorName !== undefined ? { connectorName } : undefined,
    );
  }
  return trimmed;
}

/**
 * Formats a `SlackConversationTarget` into a canonical `ConnectorContextId`.
 */
export function formatSlackContextId(
  target: SlackConversationTarget,
  connectorName?: string,
): ConnectorContextId {
  const channelId = assertValidSlackChannelId(target.channelId, connectorName);
  if (target.threadTs !== undefined) {
    const threadTs = assertValidSlackTimestamp(target.threadTs, connectorName);
    return `${target.kind}${SLACK_CONTEXT_PART_SEPARATOR}${channelId}${SLACK_CONTEXT_PART_SEPARATOR}${threadTs}` as ConnectorContextId;
  }
  return `${target.kind}${SLACK_CONTEXT_PART_SEPARATOR}${channelId}` as ConnectorContextId;
}

/**
 * Parses a structured Slack `ConnectorContextId` back into `{ kind, channelId, threadTs }`.
 * Returns `undefined` when `contextId` is an unstructured ID (such as a pre-allocated UUID).
 */
export function parseSlackContextId(contextId: string): SlackConversationTarget | undefined {
  const parts = contextId.split(SLACK_CONTEXT_PART_SEPARATOR);
  if (parts.length < MIN_CONTEXT_PARTS || parts.length > MAX_CONTEXT_PARTS) {
    return undefined;
  }

  const [rawKind, rawChannelId, rawThreadTs] = parts;
  if (rawKind !== SLACK_CONTEXT_DM_KIND && rawKind !== SLACK_CONTEXT_CHANNEL_KIND) {
    return undefined;
  }

  if (rawChannelId === undefined || !isValidSlackChannelId(rawChannelId)) {
    return undefined;
  }

  if (rawThreadTs !== undefined) {
    if (!isValidSlackTimestamp(rawThreadTs)) {
      return undefined;
    }
    return {
      kind: rawKind,
      channelId: rawChannelId.trim(),
      threadTs: rawThreadTs.trim(),
    };
  }

  return {
    kind: rawKind,
    channelId: rawChannelId.trim(),
  };
}

/**
 * Resolves the concrete Slack target using strict 3-tier priority:
 * 1. Explicit `params.channelId` (and optional `params.threadTs`)
 * 2. Structured `context.contextId` (`dm:<channelId>` or `channel:<channelId>:<threadTs>`)
 * 3. Throws `ConnectorTargetRequiredError(context.connectorName, "channelId")`
 */
export function resolveSlackSendTarget<TName extends string>(
  context: ConnectorContext<TName>,
  params: SlackSendTargetParams,
): ResolvedSlackSendTarget {
  const fallback = parseSlackContextId(context.contextId);

  const explicitChannelId =
    params.channelId !== undefined
      ? assertValidSlackChannelId(params.channelId, context.connectorName)
      : undefined;

  const explicitThreadTs =
    params.threadTs !== undefined
      ? assertValidSlackTimestamp(params.threadTs, context.connectorName)
      : undefined;

  const channelId = explicitChannelId ?? fallback?.channelId;
  if (channelId === undefined) {
    throw new ConnectorTargetRequiredError(context.connectorName, "channelId");
  }

  const threadTs =
    explicitThreadTs ??
    (explicitChannelId === undefined || explicitChannelId === fallback?.channelId
      ? fallback?.threadTs
      : undefined);

  return threadTs !== undefined ? { channelId, threadTs } : { channelId };
}
