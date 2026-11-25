import { randomUUID } from "node:crypto";
import { ConnectorValidationError } from "./errors";
import type {
  ConnectorContext,
  ConnectorContextId,
  ConnectorContextIdGenerator,
  ConnectorName,
  ContextMarkerStyle,
} from "./types";

export const CONNECTOR_CONTEXT_SEPARATOR = "--" as const;
export const MIN_CONNECTOR_NAME_LEN = 2 as const;
export const MAX_CONNECTOR_NAME_LEN = 32 as const;
export const HTML_COMMENT_CONTEXT_PREFIX = "<!-- dsh-ctx:" as const;
export const HTML_COMMENT_CONTEXT_SUFFIX = " -->" as const;
export const BRACKET_CONTEXT_PREFIX = "[#ctx:" as const;
export const BRACKET_CONTEXT_SUFFIX = "]" as const;
/** Prefix for a context id derived from one inbound message's own id. */
export const MESSAGE_CONTEXT_ID_PREFIX = "msg:" as const;

const CONNECTOR_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CONTROL_CHARS_RE = /[\r\n\0]/;

export function isValidConnectorName(name: string): name is ConnectorName {
  return (
    typeof name === "string" &&
    name.length >= MIN_CONNECTOR_NAME_LEN &&
    name.length <= MAX_CONNECTOR_NAME_LEN &&
    !name.includes(CONNECTOR_CONTEXT_SEPARATOR) &&
    CONNECTOR_NAME_RE.test(name)
  );
}

export function assertValidConnectorName(name: string): asserts name is ConnectorName {
  if (!isValidConnectorName(name)) {
    throw new ConnectorValidationError(
      `Invalid connector name "${name}": must be ${MIN_CONNECTOR_NAME_LEN}..${MAX_CONNECTOR_NAME_LEN} chars matching /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/ (no "${CONNECTOR_CONTEXT_SEPARATOR}").`,
      { connectorName: name },
    );
  }
}

export function isNonEmptyContextId(contextId: string): contextId is ConnectorContextId {
  return (
    typeof contextId === "string" &&
    contextId.trim().length > 0 &&
    !CONTROL_CHARS_RE.test(contextId)
  );
}

export function assertNonEmptyContextId(
  contextId: string,
  connectorName?: string,
): asserts contextId is ConnectorContextId {
  if (!isNonEmptyContextId(contextId)) {
    throw new ConnectorValidationError(
      "ConnectorContextId must be a non-empty single-line string without null or newline characters.",
      connectorName !== undefined ? { connectorName } : undefined,
    );
  }
}

export function createConnectorContext<const TName extends string>(
  connectorOrName: { readonly name: TName } | TName,
  contextId: ConnectorContextId | string,
): ConnectorContext<TName> {
  const connectorName =
    typeof connectorOrName === "string" ? connectorOrName : connectorOrName.name;
  assertValidConnectorName(connectorName);
  assertNonEmptyContextId(contextId, connectorName);

  return Object.freeze({
    connectorName: connectorName as TName,
    contextId,
  });
}

export function createDefaultContextIdGenerator(): ConnectorContextIdGenerator {
  return {
    generate(connectorName: string): ConnectorContextId {
      assertValidConnectorName(connectorName);
      return randomUUID() as ConnectorContextId;
    },
  };
}

function escapeMarkerToken(raw: string): string {
  return raw
    .replace(/%/g, "%25")
    .replace(/\]/g, "%5D")
    .replace(/>/g, "%3E")
    .replace(/\s/g, encodeURIComponent);
}

function unescapeMarkerToken(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

const STANDALONE_MARKER_LINE_RE =
  /^(?<quotes>(?:\s*>\s*)*)(?:<!--\s*dsh-ctx:(?<htmlToken>[^\s>]+)\s*-->|\[#ctx:(?<bracketToken>[^\]\s]+)\])\s*$/;

export function prependContextMarker(
  content: string,
  contextId: ConnectorContextId | string,
  style: ContextMarkerStyle = "html-comment",
): string {
  assertNonEmptyContextId(contextId);
  const encodedToken = escapeMarkerToken(contextId);
  const header =
    style === "html-comment"
      ? `${HTML_COMMENT_CONTEXT_PREFIX}${encodedToken}${HTML_COMMENT_CONTEXT_SUFFIX}`
      : `${BRACKET_CONTEXT_PREFIX}${encodedToken}${BRACKET_CONTEXT_SUFFIX}`;

  const lines = content.split("\n");
  const firstLine = lines[0] ?? "";
  const existingTopMatch = STANDALONE_MARKER_LINE_RE.exec(firstLine);
  const hasTopLevelUnquotedMarker =
    existingTopMatch !== null && (existingTopMatch.groups?.["quotes"] ?? "").trim().length === 0;

  const body = hasTopLevelUnquotedMarker ? lines.slice(1).join("\n") : content;
  return body.length > 0 ? `${header}\n${body}` : header;
}

export function extractContextMarker(content: string): {
  readonly contextId: ConnectorContextId | undefined;
  readonly cleanedContent: string;
} {
  const lines = content.split("\n");
  let bestDepth = Number.POSITIVE_INFINITY;
  let bestContextId: ConnectorContextId | undefined;
  const keptLines: string[] = [];

  for (const line of lines) {
    const match = STANDALONE_MARKER_LINE_RE.exec(line);
    if (match === null) {
      keptLines.push(line);
      continue;
    }

    const quotesPrefix = match.groups?.["quotes"] ?? "";
    const depth = (quotesPrefix.match(/>/g) ?? []).length;
    const rawToken = match.groups?.["htmlToken"] ?? match.groups?.["bracketToken"];

    if (rawToken !== undefined) {
      const decoded = unescapeMarkerToken(rawToken);
      if (isNonEmptyContextId(decoded) && depth < bestDepth) {
        bestDepth = depth;
        bestContextId = decoded;
      }
    }
  }

  return {
    contextId: bestContextId,
    cleanedContent: keptLines.join("\n"),
  };
}

/**
 * Builds a new context id from one inbound message id.
 * The same message id always builds the same string. A different message id does not.
 */
export function contextIdFromMessageId(messageId: string): ConnectorContextId {
  const trimmed = messageId.trim();
  if (!isNonEmptyContextId(trimmed)) {
    throw new ConnectorValidationError(
      "Inbound message id must be a non-empty single-line string without null or newline characters.",
    );
  }
  const contextId = `${MESSAGE_CONTEXT_ID_PREFIX}${trimmed}`;
  assertNonEmptyContextId(contextId);
  return contextId;
}

function quotedLines(quotedTexts: readonly (string | undefined)[] | undefined): readonly string[] {
  if (quotedTexts === undefined) return [];
  const lines: string[] = [];
  for (const quoted of quotedTexts) {
    if (quoted === undefined || quoted.length === 0) continue;
    for (const line of quoted.split("\n")) {
      lines.push(`> ${line}`);
    }
  }
  return lines;
}

/**
 * Inbound context id. A marker in the current body or in quoted/replied original
 * text already present on the payload wins. The shallowest marker line wins when
 * several are present. Otherwise the id is derived from this message's own id.
 *
 * Callers must not fetch history to fill `quotedTexts`. Pass only text the
 * inbound payload already contains.
 */
export function resolveInboundContextId(input: {
  readonly messageId: string;
  readonly body?: string;
  readonly quotedTexts?: readonly (string | undefined)[];
}): ConnectorContextId {
  const lines: string[] = [];
  if (input.body !== undefined && input.body.length > 0) {
    lines.push(input.body);
  }
  lines.push(...quotedLines(input.quotedTexts));
  if (lines.length > 0) {
    const extracted = extractContextMarker(lines.join("\n")).contextId;
    if (extracted !== undefined) return extracted;
  }
  return contextIdFromMessageId(input.messageId);
}
