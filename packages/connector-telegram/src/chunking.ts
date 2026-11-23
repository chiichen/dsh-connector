import { ConnectorValidationError } from "@dsh-connector/core";
import {
  TELEGRAM_MAX_MESSAGE_LENGTH,
  UTF16_HIGH_SURROGATE_MAX,
  UTF16_HIGH_SURROGATE_MIN,
  UTF16_LOW_SURROGATE_MAX,
  UTF16_LOW_SURROGATE_MIN,
} from "./constants";

const MIN_CHUNK_LENGTH = 2 as const;
const MIN_BREAK_RATIO_DIVISOR = 2 as const;
const PARAGRAPH_DELIMITER = "\n\n" as const;
const LINE_DELIMITER = "\n" as const;
const SPACE_DELIMITER = " " as const;

function isSurrogateSplitBoundary(text: string, splitIndex: number): boolean {
  if (splitIndex <= 0 || splitIndex >= text.length) {
    return false;
  }
  const prevCode = text.charCodeAt(splitIndex - 1);
  const nextCode = text.charCodeAt(splitIndex);
  return (
    prevCode >= UTF16_HIGH_SURROGATE_MIN &&
    prevCode <= UTF16_HIGH_SURROGATE_MAX &&
    nextCode >= UTF16_LOW_SURROGATE_MIN &&
    nextCode <= UTF16_LOW_SURROGATE_MAX
  );
}

/**
 * Splits outbound text into valid `1..4096` UTF-16 code-unit chunks required by Telegram
 * `sendMessage`, preferring paragraph (`\n\n`), line (`\n`), and word (` `) boundaries in the
 * latter half of each window so early header lines never produce tiny stub chunks, and never
 * severing a UTF-16 surrogate pair.
 *
 * @see https://core.telegram.org/bots/api#sendmessage
 */
export function splitTelegramMessageText(
  text: string,
  maxLength: number = TELEGRAM_MAX_MESSAGE_LENGTH,
  connectorName?: string,
): string[] {
  const errorOptions = connectorName !== undefined ? { connectorName } : undefined;
  if (text.length === 0) {
    throw new ConnectorValidationError("Telegram message text must not be empty.", errorOptions);
  }
  if (!Number.isSafeInteger(maxLength) || maxLength < MIN_CHUNK_LENGTH) {
    throw new ConnectorValidationError(
      `Telegram maxLength must be an integer >= ${MIN_CHUNK_LENGTH}.`,
      errorOptions,
    );
  }

  if (text.length <= maxLength) {
    return [text];
  }

  const minNaturalBreak = Math.max(1, Math.floor(maxLength / MIN_BREAK_RATIO_DIVISOR));
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const remaining = text.length - cursor;
    if (remaining <= maxLength) {
      chunks.push(text.slice(cursor));
      break;
    }

    const windowSlice = text.slice(cursor, cursor + maxLength);

    const paragraphIdx = windowSlice.lastIndexOf(PARAGRAPH_DELIMITER);
    if (paragraphIdx >= minNaturalBreak) {
      chunks.push(windowSlice.slice(0, paragraphIdx));
      cursor += paragraphIdx + PARAGRAPH_DELIMITER.length;
      continue;
    }

    const lineIdx = windowSlice.lastIndexOf(LINE_DELIMITER);
    if (lineIdx >= minNaturalBreak) {
      chunks.push(windowSlice.slice(0, lineIdx));
      cursor += lineIdx + LINE_DELIMITER.length;
      continue;
    }

    const spaceIdx = windowSlice.lastIndexOf(SPACE_DELIMITER);
    if (spaceIdx >= minNaturalBreak) {
      chunks.push(windowSlice.slice(0, spaceIdx));
      cursor += spaceIdx + SPACE_DELIMITER.length;
      continue;
    }

    let splitAt = cursor + maxLength;
    if (isSurrogateSplitBoundary(text, splitAt)) {
      splitAt -= 1;
    }

    chunks.push(text.slice(cursor, splitAt));
    cursor = splitAt;
  }

  return chunks;
}
