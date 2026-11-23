import { ConnectorValidationError } from "@dsh-connector/core";
import { MAX_UNICODE_CODE_POINT } from "./constants";

const XML_ROOT_RE = /<xml\b[^>]*>([\s\S]*?)<\/xml>/i;
const XML_LEAF_TAG_RE = /<([A-Za-z0-9_]+)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/\1>/g;
const XML_ENTITY_RE = /&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;

function decodeXmlEntities(raw: string): string {
  return raw.replace(XML_ENTITY_RE, (full, entity: string) => {
    switch (entity) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        if (entity.startsWith("#x") || entity.startsWith("#X")) {
          const codePoint = Number(`0x${entity.slice(2)}`);
          return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= MAX_UNICODE_CODE_POINT
            ? String.fromCodePoint(codePoint)
            : full;
        }
        if (entity.startsWith("#")) {
          const codePoint = Number(entity.slice(1));
          return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= MAX_UNICODE_CODE_POINT
            ? String.fromCodePoint(codePoint)
            : full;
        }
        return full;
      }
    }
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a WeChat webhook callback body in either standard `<xml>...</xml>` or JSON object format
 * into a flat string dictionary (`ToUserName`, `FromUserName`, `MsgType`, `Content`, `Encrypt`, etc.).
 *
 * @see https://developers.weixin.qq.com/doc/service/guide/product/message/Receiving_standard_messages.html
 * @see https://developers.weixin.qq.com/doc/oplatform/developers/dev/push/encryption.html
 */
export function parseWeixinCallbackBody(
  rawBody: string,
  connectorName?: string,
): Record<string, string> {
  const errOpts = connectorName !== undefined ? { connectorName } : undefined;
  const trimmed = rawBody.trim();
  if (trimmed.length === 0) {
    throw new ConnectorValidationError("Weixin callback body must not be empty.", errOpts);
  }

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new ConnectorValidationError("Invalid JSON in Weixin callback body.", {
        ...errOpts,
        cause: error,
      });
    }
    if (!isPlainRecord(parsed)) {
      throw new ConnectorValidationError("Weixin JSON callback body must be an object.", errOpts);
    }

    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        fields[key] = value;
      } else if (typeof value === "number" || typeof value === "boolean") {
        fields[key] = String(value);
      }
    }
    return fields;
  }

  const rootMatch = XML_ROOT_RE.exec(trimmed);
  if (rootMatch === null) {
    throw new ConnectorValidationError(
      "Invalid Weixin XML callback body: missing <xml>...</xml> envelope.",
      errOpts,
    );
  }

  const innerXml = rootMatch[1]!;
  const fields: Record<string, string> = {};
  XML_LEAF_TAG_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = XML_LEAF_TAG_RE.exec(innerXml)) !== null) {
    const tagName = match[1]!;
    const cdataContent = match[2];
    const textContent = match[3];
    fields[tagName] =
      cdataContent !== undefined ? cdataContent : decodeXmlEntities((textContent ?? "").trim());
  }

  return fields;
}
