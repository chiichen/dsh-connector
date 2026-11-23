import { ConnectorValidationError } from "@dsh-connector/core";
import {
  DEFAULT_MAX_MESSAGE_CHARS,
  DEFAULT_OFFICIAL_MAX_MESSAGE_BYTES,
  FENCE_CLOSE_MARKER,
  MIN_CHUNK_CHARS,
  MIN_CHUNK_UTF8_BYTES,
  MIN_LINE_SPLIT_RATIO,
} from "./constants";

export interface SplitWeixinTextOptions {
  readonly maxChars?: number;
  readonly maxUtf8Bytes?: number;
}

const CODE_FENCE_LINE_RE = /^(\s*`{3,})([^\r\n`]*)$/;

function fitsLimits(text: string, maxChars: number, maxUtf8Bytes: number): boolean {
  if (text.length > maxChars) {
    return false;
  }
  if (maxUtf8Bytes > 0 && Buffer.byteLength(text, "utf8") > maxUtf8Bytes) {
    return false;
  }
  return true;
}

/**
 * Computes the maximum UTF-16 prefix index of `text` that satisfies both `maxChars` and
 * `maxUtf8Bytes` without splitting a UTF-16 surrogate pair.
 */
function maxSafePrefixEnd(text: string, maxChars: number, maxUtf8Bytes: number): number {
  let utf16Offset = 0;
  let utf8Bytes = 0;

  for (const codePointStr of text) {
    const nextUtf16 = utf16Offset + codePointStr.length;
    if (nextUtf16 > maxChars) {
      break;
    }

    if (maxUtf8Bytes > 0) {
      const cpBytes = Buffer.byteLength(codePointStr, "utf8");
      if (utf8Bytes + cpBytes > maxUtf8Bytes) {
        break;
      }
      utf8Bytes += cpBytes;
    }

    utf16Offset = nextUtf16;
  }

  return utf16Offset;
}

/**
 * Tracks whether `chunk` ends inside an unclosed Markdown fenced code block (` ```lang `).
 * Returns the opening fence line (e.g. `"```ts"`) if still open, or `undefined` if balanced.
 */
function detectUnclosedCodeFence(chunk: string): string | undefined {
  const lines = chunk.split("\n");
  let openFenceMarker: string | undefined;
  let openFenceTicksLen = 0;

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = CODE_FENCE_LINE_RE.exec(line);
    if (match === null) {
      continue;
    }
    const ticks = match[1]!.trim();
    const info = match[2]!.trim();
    if (openFenceMarker === undefined) {
      openFenceMarker = `${ticks}${info}`;
      openFenceTicksLen = ticks.length;
    } else if (info.length === 0 && ticks.length >= openFenceTicksLen) {
      openFenceMarker = undefined;
      openFenceTicksLen = 0;
    }
  }

  return openFenceMarker;
}

/**
 * Splits outbound WeChat text into safe chunks respecting both character count (`maxChars`)
 * and UTF-8 byte budget (`maxUtf8Bytes`, preventing WeChat `errcode=45002 content size out of limit`),
 * while preserving Unicode surrogate pairs, preferring newline breaks, and balancing Markdown code fences.
 *
 * @see https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html
 * @see https://developers.weixin.qq.com/doc/oplatform/developers/errCode/
 */
export function splitWeixinText(text: string, options?: SplitWeixinTextOptions): string[] {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  const maxUtf8Bytes = options?.maxUtf8Bytes ?? DEFAULT_OFFICIAL_MAX_MESSAGE_BYTES;

  if (!Number.isInteger(maxChars) || maxChars < MIN_CHUNK_CHARS) {
    throw new ConnectorValidationError(
      `splitWeixinText maxChars must be an integer >= ${MIN_CHUNK_CHARS}.`,
    );
  }
  if (
    !Number.isInteger(maxUtf8Bytes) ||
    (maxUtf8Bytes !== 0 && maxUtf8Bytes < MIN_CHUNK_UTF8_BYTES)
  ) {
    throw new ConnectorValidationError(
      `splitWeixinText maxUtf8Bytes must be 0 (unlimited) or an integer >= ${MIN_CHUNK_UTF8_BYTES}.`,
    );
  }

  if (text.length === 0 || fitsLimits(text, maxChars, maxUtf8Bytes)) {
    return [text];
  }

  const fenceCloseChars = FENCE_CLOSE_MARKER.length;
  const fenceCloseBytes = Buffer.byteLength(FENCE_CLOSE_MARKER, "utf8");
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (fitsLimits(remaining, maxChars, maxUtf8Bytes)) {
      chunks.push(remaining);
      break;
    }

    // Reserve room in case an unclosed Markdown code fence needs `\n``` ` appended.
    const budgetChars = Math.max(MIN_CHUNK_CHARS, maxChars - fenceCloseChars);
    const budgetBytes =
      maxUtf8Bytes > 0 ? Math.max(MIN_CHUNK_UTF8_BYTES, maxUtf8Bytes - fenceCloseBytes) : 0;

    let hardEnd = maxSafePrefixEnd(remaining, budgetChars, budgetBytes);
    if (hardEnd === 0) {
      hardEnd = maxSafePrefixEnd(remaining, maxChars, maxUtf8Bytes);
    }

    const minNewlineIndex = Math.floor(hardEnd * MIN_LINE_SPLIT_RATIO);
    const lastNewline = remaining.lastIndexOf("\n", hardEnd);
    const splitAt = lastNewline >= minNewlineIndex && lastNewline > 0 ? lastNewline : hardEnd;

    const rawChunk = remaining.slice(0, splitAt);
    let nextRemaining = remaining.slice(splitAt);
    if (splitAt === lastNewline) {
      nextRemaining = nextRemaining.replace(/^\n/, "");
    }

    const unclosedFence = detectUnclosedCodeFence(rawChunk);
    if (
      unclosedFence !== undefined &&
      nextRemaining.length > 0 &&
      fitsLimits(`${rawChunk}${FENCE_CLOSE_MARKER}`, maxChars, maxUtf8Bytes)
    ) {
      chunks.push(`${rawChunk}${FENCE_CLOSE_MARKER}`);
      remaining = `${unclosedFence}\n${nextRemaining}`;
    } else {
      chunks.push(rawChunk);
      remaining = nextRemaining;
    }
  }

  return chunks;
}
