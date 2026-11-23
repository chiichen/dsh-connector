import { ConnectorValidationError } from "@dsh-connector/core";
import { WHATSAPP_MAX_TEXT_LENGTH } from "./constants";

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const MIN_CODE_FENCE_AWARE_MAX_LENGTH = 32;
const SPLIT_WINDOW_DIVISOR = 2;
const CODE_FENCE_MARKER = "```";
const CODE_FENCE_CLOSE_SUFFIX = "\n```";
const PARAGRAPH_BREAK = "\n\n";
const LINE_BREAK = "\n";
const WORD_BREAK = " ";

const FENCE_OPEN_RE = /^ {0,3}(`{3,})([^\n`]*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,})[ \t]*$/;

interface ActiveFence {
  readonly ticks: string;
  readonly info: string;
}

function scanActiveFence(text: string): ActiveFence | undefined {
  const lines = text.split(LINE_BREAK);
  let active: ActiveFence | undefined;

  for (const line of lines) {
    if (active === undefined) {
      const openMatch = FENCE_OPEN_RE.exec(line);
      if (openMatch !== null) {
        active = {
          ticks: openMatch[1] ?? CODE_FENCE_MARKER,
          info: (openMatch[2] ?? "").trim(),
        };
      }
    } else {
      const closeMatch = FENCE_CLOSE_RE.exec(line);
      if (closeMatch !== null && (closeMatch[1] ?? "").length >= active.ticks.length) {
        active = undefined;
      }
    }
  }

  return active;
}

function adjustSurrogateBoundary(text: string, index: number): number {
  if (index <= 1 || index >= text.length) {
    return index;
  }
  const prevCode = text.charCodeAt(index - 1);
  if (prevCode >= HIGH_SURROGATE_MIN && prevCode <= HIGH_SURROGATE_MAX) {
    return index - 1;
  }
  return index;
}

function findNaturalBreak(text: string, budget: number): { splitAt: number; skipLen: number } {
  const minBreak = Math.max(1, Math.floor(budget / SPLIT_WINDOW_DIVISOR));

  const paraIdx = text.lastIndexOf(PARAGRAPH_BREAK, budget - PARAGRAPH_BREAK.length);
  if (paraIdx >= minBreak) {
    return { splitAt: paraIdx, skipLen: PARAGRAPH_BREAK.length };
  }

  const lineIdx = text.lastIndexOf(LINE_BREAK, budget - LINE_BREAK.length);
  if (lineIdx >= minBreak) {
    return { splitAt: lineIdx, skipLen: LINE_BREAK.length };
  }

  const spaceIdx = text.lastIndexOf(WORD_BREAK, budget - WORD_BREAK.length);
  if (spaceIdx >= minBreak) {
    return { splitAt: spaceIdx, skipLen: WORD_BREAK.length };
  }

  return { splitAt: adjustSurrogateBoundary(text, budget), skipLen: 0 };
}

/**
 * Splits outbound text into chunks that each satisfy Meta WhatsApp Business Cloud API's
 * 4096-character limit (`text.body`), preserving UTF-16 surrogate pairs and closing/reopening
 * fenced Markdown code blocks across chunk boundaries.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages
 */
export function splitWhatsAppText(
  text: string,
  maxLength: number = WHATSAPP_MAX_TEXT_LENGTH,
): string[] {
  if (!Number.isSafeInteger(maxLength) || maxLength <= 0) {
    throw new ConnectorValidationError("maxTextLength must be a positive safe integer.");
  }
  if (text.length === 0) {
    throw new ConnectorValidationError("Outbound WhatsApp text must be non-empty.");
  }
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const mayContainFence =
      maxLength >= MIN_CODE_FENCE_AWARE_MAX_LENGTH &&
      remaining.slice(0, maxLength).includes(CODE_FENCE_MARKER);

    const budget = mayContainFence ? maxLength - CODE_FENCE_CLOSE_SUFFIX.length : maxLength;
    const { splitAt, skipLen } = findNaturalBreak(remaining, budget);
    const rawChunk = remaining.slice(0, splitAt);
    const nextRemainder = remaining.slice(splitAt + skipLen);

    const unclosedFence = mayContainFence ? scanActiveFence(rawChunk) : undefined;
    if (unclosedFence !== undefined) {
      chunks.push(`${rawChunk}${CODE_FENCE_CLOSE_SUFFIX}`);
      const reopenHeader = `${unclosedFence.ticks}${unclosedFence.info}${LINE_BREAK}`;
      remaining = `${reopenHeader}${nextRemainder}`;
    } else {
      chunks.push(rawChunk);
      remaining = nextRemainder;
    }
  }

  return chunks;
}
