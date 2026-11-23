import {
  ConnectorTargetRequiredError,
  ConnectorValidationError,
  assertNonEmptyContextId,
  type ConnectorContextId,
} from "@dsh-connector/core";
import { WEIXIN_P2P_CONTEXT_PREFIX } from "./constants";

/**
 * Formats a WeChat user OpenID / iLink user ID into a structured P2P `ConnectorContextId` (`p2p:<id>`).
 */
export function formatWeixinP2pContextId(
  userId: string,
  connectorName?: string,
): ConnectorContextId {
  const trimmed = userId.trim();
  if (trimmed.length === 0) {
    throw new ConnectorValidationError(
      "Weixin user identifier must be a non-empty string.",
      connectorName !== undefined ? { connectorName } : undefined,
    );
  }
  const formatted = `${WEIXIN_P2P_CONTEXT_PREFIX}${trimmed}`;
  assertNonEmptyContextId(formatted, connectorName);
  return formatted;
}

/**
 * Extracts the WeChat recipient identifier from a structured `p2p:<id>` `contextId`.
 *
 * Returns `undefined` for unstructured or pre-allocated UUID `contextId` values so an
 * outbound-first UUID is never mistaken for a real WeChat `OpenID`.
 */
export function parseWeixinTargetFromContextId(contextId: string): string | undefined {
  if (!contextId.startsWith(WEIXIN_P2P_CONTEXT_PREFIX)) {
    return undefined;
  }
  const candidate = contextId.slice(WEIXIN_P2P_CONTEXT_PREFIX.length).trim();
  return candidate.length > 0 ? candidate : undefined;
}

/**
 * Resolves the WeChat outbound recipient following the 3-tier priority rule:
 * 1. Explicit `params.openId` or `params.toUserId`
 * 2. Structured `p2p:<id>` parsed from `context.contextId`
 * 3. Throws `ConnectorTargetRequiredError`
 */
export function resolveWeixinSendTarget(
  connectorName: string,
  contextId: string,
  params: { readonly openId?: string; readonly toUserId?: string },
): string {
  const explicitOpenId = params.openId?.trim();
  if (explicitOpenId !== undefined && explicitOpenId.length > 0) {
    return explicitOpenId;
  }

  const explicitToUserId = params.toUserId?.trim();
  if (explicitToUserId !== undefined && explicitToUserId.length > 0) {
    return explicitToUserId;
  }

  const contextTarget = parseWeixinTargetFromContextId(contextId);
  if (contextTarget !== undefined) {
    return contextTarget;
  }

  throw new ConnectorTargetRequiredError(connectorName, "openId");
}
