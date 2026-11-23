import { ConnectorValidationError, type ConnectorContextId } from "@dsh-connector/core";
import {
  GENERIC_CONTEXT_PREFIX_GROUP,
  GENERIC_CONTEXT_PREFIX_P2P,
  MIN_UTF8_SPLIT_MAX_BYTES,
  WECOM_CONTEXT_PREFIX_AIBOT_GROUP,
  WECOM_CONTEXT_PREFIX_AIBOT_P2P,
  WECOM_CONTEXT_PREFIX_APP_GROUP,
  WECOM_CONTEXT_PREFIX_APP_P2P,
  WECOM_CONTEXT_PREFIX_WEBHOOK,
} from "./constants";

export type WeComContextTarget =
  | {
      readonly channel: "app" | "aibot";
      readonly peerKind: "p2p" | "group";
      readonly targetId: string;
    }
  | {
      readonly channel: "webhook";
      readonly targetId: string;
    };

const UUID_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidLikeContextId(contextId: string): boolean {
  return UUID_LIKE_RE.test(contextId.trim());
}

export function formatWeComContextId(target: WeComContextTarget): ConnectorContextId {
  const cleanedTarget = target.targetId.trim();
  if (cleanedTarget.length === 0) {
    throw new ConnectorValidationError("WeCom targetId must not be empty.");
  }

  if (target.channel === "webhook") {
    return `${WECOM_CONTEXT_PREFIX_WEBHOOK}${cleanedTarget}` as ConnectorContextId;
  }

  if (target.channel === "app") {
    const prefix =
      target.peerKind === "p2p" ? WECOM_CONTEXT_PREFIX_APP_P2P : WECOM_CONTEXT_PREFIX_APP_GROUP;
    return `${prefix}${cleanedTarget}` as ConnectorContextId;
  }

  const prefix =
    target.peerKind === "p2p" ? WECOM_CONTEXT_PREFIX_AIBOT_P2P : WECOM_CONTEXT_PREFIX_AIBOT_GROUP;
  return `${prefix}${cleanedTarget}` as ConnectorContextId;
}

/**
 * Parses structured WeCom business targets encoded inside `context.contextId`.
 * Returns `undefined` for pre-allocated UUIDv4 context IDs or unrecognized shapes
 * so outbound-first calls never send session UUIDs as WeCom user/chat IDs.
 */
export function parseWeComContextTarget(
  contextId: string,
  defaultConversationChannel: "app" | "aibot" = "app",
): WeComContextTarget | undefined {
  const raw = contextId.trim();
  if (raw.length === 0 || isUuidLikeContextId(raw)) {
    return undefined;
  }

  const sliceNonEmpty = (prefix: string): string | undefined => {
    if (!raw.startsWith(prefix)) {
      return undefined;
    }
    const rest = raw.slice(prefix.length).trim();
    return rest.length > 0 ? rest : undefined;
  };

  const appP2p = sliceNonEmpty(WECOM_CONTEXT_PREFIX_APP_P2P);
  if (appP2p !== undefined) {
    return { channel: "app", peerKind: "p2p", targetId: appP2p };
  }

  const appGroup = sliceNonEmpty(WECOM_CONTEXT_PREFIX_APP_GROUP);
  if (appGroup !== undefined) {
    return { channel: "app", peerKind: "group", targetId: appGroup };
  }

  const aibotP2p = sliceNonEmpty(WECOM_CONTEXT_PREFIX_AIBOT_P2P);
  if (aibotP2p !== undefined) {
    return { channel: "aibot", peerKind: "p2p", targetId: aibotP2p };
  }

  const aibotGroup = sliceNonEmpty(WECOM_CONTEXT_PREFIX_AIBOT_GROUP);
  if (aibotGroup !== undefined) {
    return { channel: "aibot", peerKind: "group", targetId: aibotGroup };
  }

  const webhookKey = sliceNonEmpty(WECOM_CONTEXT_PREFIX_WEBHOOK);
  if (webhookKey !== undefined) {
    return { channel: "webhook", targetId: webhookKey };
  }

  const genericP2p = sliceNonEmpty(GENERIC_CONTEXT_PREFIX_P2P);
  if (genericP2p !== undefined) {
    return { channel: defaultConversationChannel, peerKind: "p2p", targetId: genericP2p };
  }

  const genericGroup = sliceNonEmpty(GENERIC_CONTEXT_PREFIX_GROUP);
  if (genericGroup !== undefined) {
    return { channel: defaultConversationChannel, peerKind: "group", targetId: genericGroup };
  }

  return undefined;
}

/**
 * Splits UTF-8 text into chunks each <= `maxBytes` UTF-8 bytes on Unicode code-point boundaries,
 * ensuring multi-byte CJK characters (3 bytes) and astral-plane emojis (4 bytes) are never split mid-sequence.
 *
 * @see https://developer.work.weixin.qq.com/document/path/96458
 * @see https://developer.work.weixin.qq.com/document/path/99110
 */
export function splitUtf8ByBytes(text: string, maxBytes: number): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < MIN_UTF8_SPLIT_MAX_BYTES) {
    throw new ConnectorValidationError(
      `maxBytes must be an integer >= ${MIN_UTF8_SPLIT_MAX_BYTES}, received ${maxBytes}.`,
    );
  }

  if (text.length === 0) {
    return [""];
  }

  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return [text];
  }

  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const codePoint of text) {
    const charBytes = Buffer.byteLength(codePoint, "utf8");
    if (currentBytes + charBytes > maxBytes && current.length > 0) {
      chunks.push(current);
      current = codePoint;
      currentBytes = charBytes;
    } else {
      current += codePoint;
      currentBytes += charBytes;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}
