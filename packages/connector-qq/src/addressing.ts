import {
  ConnectorTargetRequiredError,
  ConnectorValidationError,
  type ConnectorContext,
} from "@dsh-connector/core";
import {
  QQ_CONTEXT_PREFIX_C2C,
  QQ_CONTEXT_PREFIX_CHANNEL,
  QQ_CONTEXT_PREFIX_GROUP,
} from "./constants";
import type { QqSendParams, QqTarget } from "./types";

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Formats a `QqTarget` into a deterministic, unprefixed-by-connector `ConnectorContextId`.
 * - C2C: `c2c:<openId>`
 * - Group: `group:<groupOpenId>`
 * - Channel: `channel:<guildId>:<channelId>` or `channel:<channelId>`
 */
export function formatQqContextId(target: QqTarget): string {
  switch (target.scene) {
    case "c2c": {
      const openId = nonEmptyTrimmed(target.openId);
      if (openId === undefined) {
        throw new ConnectorValidationError("QQ C2C target requires a non-empty openId.");
      }
      return `${QQ_CONTEXT_PREFIX_C2C}${openId}`;
    }
    case "group": {
      const groupOpenId = nonEmptyTrimmed(target.groupOpenId);
      if (groupOpenId === undefined) {
        throw new ConnectorValidationError("QQ group target requires a non-empty groupOpenId.");
      }
      return `${QQ_CONTEXT_PREFIX_GROUP}${groupOpenId}`;
    }
    case "channel": {
      const channelId = nonEmptyTrimmed(target.channelId);
      if (channelId === undefined) {
        throw new ConnectorValidationError("QQ channel target requires a non-empty channelId.");
      }
      const guildId = nonEmptyTrimmed(target.guildId);
      return guildId !== undefined
        ? `${QQ_CONTEXT_PREFIX_CHANNEL}${guildId}:${channelId}`
        : `${QQ_CONTEXT_PREFIX_CHANNEL}${channelId}`;
    }
  }
}

/**
 * Canonical lookup key for passive-reply tracking per chat container.
 */
export function getQqTargetKey(target: QqTarget): string {
  switch (target.scene) {
    case "c2c":
      return `${QQ_CONTEXT_PREFIX_C2C}${target.openId}`;
    case "group":
      return `${QQ_CONTEXT_PREFIX_GROUP}${target.groupOpenId}`;
    case "channel":
      return `${QQ_CONTEXT_PREFIX_CHANNEL}${target.channelId}`;
  }
}

/**
 * Parses a structured business `ConnectorContextId` into a `QqTarget`.
 * Pure UUIDs (allocated on outbound-first sessions) return `undefined` so they
 * are never mistaken for QQ OpenIDs or channel IDs.
 */
export function parseQqContextId(contextId: string): QqTarget | undefined {
  if (contextId.startsWith(QQ_CONTEXT_PREFIX_C2C)) {
    const openId = nonEmptyTrimmed(contextId.slice(QQ_CONTEXT_PREFIX_C2C.length));
    return openId !== undefined ? { scene: "c2c", openId } : undefined;
  }

  if (contextId.startsWith(QQ_CONTEXT_PREFIX_GROUP)) {
    const groupOpenId = nonEmptyTrimmed(contextId.slice(QQ_CONTEXT_PREFIX_GROUP.length));
    return groupOpenId !== undefined ? { scene: "group", groupOpenId } : undefined;
  }

  if (contextId.startsWith(QQ_CONTEXT_PREFIX_CHANNEL)) {
    const rest = contextId.slice(QQ_CONTEXT_PREFIX_CHANNEL.length);
    if (rest.length === 0) {
      return undefined;
    }
    const parts = rest.split(":");
    if (parts.length === 1) {
      const channelId = nonEmptyTrimmed(parts[0]);
      return channelId !== undefined ? { scene: "channel", channelId } : undefined;
    }
    if (parts.length === 2) {
      const guildId = nonEmptyTrimmed(parts[0]);
      const channelId = nonEmptyTrimmed(parts[1]);
      if (guildId === undefined || channelId === undefined) {
        return undefined;
      }
      return { scene: "channel", guildId, channelId };
    }
    return undefined;
  }

  return undefined;
}

/**
 * Resolves the outbound `QqTarget` following the strict 3-tier priority:
 * 1. Explicit target fields in `params` (`openId` / `groupOpenId` / `channelId`)
 * 2. Structured business target parsed from `context.contextId`
 * 3. Throw `ConnectorTargetRequiredError`
 */
export function resolveQqSendTarget(
  connectorName: string,
  context: ConnectorContext,
  params: Pick<QqSendParams, "scene" | "openId" | "groupOpenId" | "channelId">,
): QqTarget {
  const openId = nonEmptyTrimmed(params.openId);
  const groupOpenId = nonEmptyTrimmed(params.groupOpenId);
  const channelId = nonEmptyTrimmed(params.channelId);

  const explicitTargets: QqTarget[] = [];
  if (openId !== undefined) {
    explicitTargets.push({ scene: "c2c", openId });
  }
  if (groupOpenId !== undefined) {
    explicitTargets.push({ scene: "group", groupOpenId });
  }
  if (channelId !== undefined) {
    explicitTargets.push({ scene: "channel", channelId });
  }

  if (explicitTargets.length > 1) {
    throw new ConnectorValidationError(
      "Provide at most one explicit QQ target parameter among openId, groupOpenId, and channelId.",
      { connectorName },
    );
  }

  const explicitTarget = explicitTargets[0];
  if (explicitTarget !== undefined) {
    if (params.scene !== undefined && params.scene !== explicitTarget.scene) {
      throw new ConnectorValidationError(
        `Explicit scene "${params.scene}" conflicts with target field for scene "${explicitTarget.scene}".`,
        { connectorName },
      );
    }
    return explicitTarget;
  }

  const contextTarget = parseQqContextId(context.contextId);
  if (contextTarget !== undefined) {
    if (params.scene !== undefined && params.scene !== contextTarget.scene) {
      throw new ConnectorValidationError(
        `Explicit scene "${params.scene}" conflicts with context target scene "${contextTarget.scene}".`,
        { connectorName },
      );
    }
    return contextTarget;
  }

  const missingField =
    params.scene === "c2c"
      ? "openId"
      : params.scene === "group"
        ? "groupOpenId"
        : params.scene === "channel"
          ? "channelId"
          : "openId | groupOpenId | channelId";

  throw new ConnectorTargetRequiredError(connectorName, missingField);
}

/**
 * Builds the official QQ OpenAPI relative endpoint path for sending a message.
 * - C2C: `/v2/users/{openid}/messages`
 * - Group: `/v2/groups/{group_openid}/messages`
 * - Channel: `/channels/{channel_id}/messages`
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/send.html
 */
export function buildQqSendEndpoint(target: QqTarget): string {
  switch (target.scene) {
    case "c2c":
      return `/v2/users/${encodeURIComponent(target.openId)}/messages`;
    case "group":
      return `/v2/groups/${encodeURIComponent(target.groupOpenId)}/messages`;
    case "channel":
      return `/channels/${encodeURIComponent(target.channelId)}/messages`;
  }
}
