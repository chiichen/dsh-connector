/**
 * Markdown-aware and UTF-16 surrogate-safe message chunker enforcing Discord's
 * 2000-character message content limit (`POST /channels/{channel.id}/messages`).
 *
 * @see https://discord.com/developers/docs/resources/message#create-message-jsonform-params
 */

import { ConnectorValidationError } from "@dsh-connector/core";
import { DISCORD_MAX_MESSAGE_LENGTH } from "./constants";

const FENCE_CLOSE_LINE = "\n```";
const MIN_FENCE_CHUNK_OVERHEAD = 16;
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;
const FENCE_OPEN_RE = /^ {0,3}(`{3,})([^\n`]*)$/;

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= HIGH_SURROGATE_MIN && codeUnit <= HIGH_SURROGATE_MAX;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= LOW_SURROGATE_MIN && codeUnit <= LOW_SURROGATE_MAX;
}

/**
 * Adjusts a UTF-16 slice index downwards if it lands between a high and low surrogate pair.
 */
function safeUtf16Boundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) {
    return Math.max(0, Math.min(index, text.length));
  }
  const prev = text.charCodeAt(index - 1);
  const curr = text.charCodeAt(index);
  if (isHighSurrogate(prev) && isLowSurrogate(curr)) {
    return index - 1;
  }
  return index;
}

/**
 * Picks a natural split boundary (`\n\n` > `\n` > whitespace > safe UTF-16 code point)
 * within `[1, budget]`.
 */
function findNaturalSplitIndex(text: string, budget: number): number {
  if (text.length <= budget) {
    return text.length;
  }
  const cappedBudget = safeUtf16Boundary(text, budget);
  if (cappedBudget <= 0) {
    return text.length >= 2 &&
      isHighSurrogate(text.charCodeAt(0)) &&
      isLowSurrogate(text.charCodeAt(1))
      ? 2
      : 1;
  }

  const minPreferredBreak = Math.floor(cappedBudget / 3);
  const window = text.slice(0, cappedBudget);

  const doubleNewline = window.lastIndexOf("\n\n");
  if (doubleNewline >= minPreferredBreak) {
    return doubleNewline;
  }

  const singleNewline = window.lastIndexOf("\n");
  if (singleNewline >= minPreferredBreak) {
    return singleNewline;
  }

  const lastSpace = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
  if (lastSpace >= minPreferredBreak) {
    return lastSpace;
  }

  return cappedBudget;
}

interface FenceState {
  readonly marker: string;
  readonly header: string;
}

/**
 * Tracks whether `chunkText` leaves an unclosed Markdown code fence at its end.
 */
function computeOpenFence(initialFence: FenceState | null, chunkBody: string): FenceState | null {
  let active = initialFence;
  const lines = chunkBody.split("\n");
  for (const line of lines) {
    const trimmedRight = line.replace(/\r$/, "");
    const match = FENCE_OPEN_RE.exec(trimmedRight);
    if (match === null) {
      continue;
    }
    const backticks = match[1] ?? "```";
    const info = (match[2] ?? "").trim();
    if (active === null) {
      active = {
        marker: backticks,
        header: `${backticks}${info}`,
      };
    } else if (backticks.length >= active.marker.length && info.length === 0) {
      active = null;
    }
  }
  return active;
}

/**
 * Splits `content` into one or more non-empty chunks where every chunk has `.length <= maxLength`
 * (defaulting to Discord's 2000-character limit), preserving Markdown code fences and UTF-16 surrogate pairs.
 *
 * @see https://discord.com/developers/docs/resources/message#create-message-jsonform-params
 */
export function splitDiscordMessage(
  content: string,
  maxLength: number = DISCORD_MAX_MESSAGE_LENGTH,
): string[] {
  if (!Number.isInteger(maxLength) || maxLength < MIN_FENCE_CHUNK_OVERHEAD) {
    throw new ConnectorValidationError(
      `splitDiscordMessage maxLength must be an integer >= ${MIN_FENCE_CHUNK_OVERHEAD}, got ${String(maxLength)}.`,
    );
  }

  if (content.length === 0) {
    return [];
  }

  if (content.length <= maxLength) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;
  let carriedFence: FenceState | null = null;

  while (remaining.length > 0) {
    const reopenPrefix: string = carriedFence !== null ? `${carriedFence.header}\n` : "";
    const closeReserve: number =
      carriedFence !== null ? carriedFence.marker.length + 1 : FENCE_CLOSE_LINE.length;

    if (reopenPrefix.length + remaining.length <= maxLength) {
      chunks.push(`${reopenPrefix}${remaining}`);
      break;
    }

    const rawBudget: number = Math.max(1, maxLength - reopenPrefix.length - closeReserve);
    const splitIdx: number = findNaturalSplitIndex(remaining, rawBudget);
    const sliceBody: string = remaining.slice(0, splitIdx);
    const endFence: FenceState | null = computeOpenFence(carriedFence, sliceBody);

    if (endFence !== null) {
      const closingSuffix = `\n${endFence.marker}`;
      chunks.push(`${reopenPrefix}${sliceBody}${closingSuffix}`);
    } else {
      chunks.push(`${reopenPrefix}${sliceBody}`);
    }

    let nextRemaining = remaining.slice(splitIdx);
    if (nextRemaining.startsWith("\n\n")) {
      nextRemaining = nextRemaining.slice(2);
    } else if (nextRemaining.startsWith("\n") || nextRemaining.startsWith(" ")) {
      nextRemaining = nextRemaining.slice(1);
    }

    carriedFence = endFence;
    remaining = nextRemaining;
  }

  return chunks;
}
