import { ConnectorValidationError } from "@dsh-connector/core";
import { describe, expect, it } from "vitest";
import { splitTelegramMessageText } from "../src/chunking";
import { TELEGRAM_MAX_MESSAGE_LENGTH } from "../src/constants";

describe("splitTelegramMessageText (4096-char safe chunking)", () => {
  it("returns single-element array when text fits within 4096 UTF-16 code units", () => {
    expect(splitTelegramMessageText("Short reply")).toEqual(["Short reply"]);
    const exactMax = "a".repeat(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(splitTelegramMessageText(exactMax)).toEqual([exactMax]);
  });

  it("prefers paragraph, newline, and space boundaries before hard splitting", () => {
    const paragraphText = `${"A".repeat(30)}\n\n${"B".repeat(30)}`;
    expect(splitTelegramMessageText(paragraphText, 40)).toEqual(["A".repeat(30), "B".repeat(30)]);

    const lineText = `${"C".repeat(30)}\n${"D".repeat(30)}`;
    expect(splitTelegramMessageText(lineText, 40)).toEqual(["C".repeat(30), "D".repeat(30)]);

    const wordText = `${"E".repeat(25)} ${"F".repeat(25)}`;
    expect(splitTelegramMessageText(wordText, 35)).toEqual(["E".repeat(25), "F".repeat(25)]);
  });

  it("hard-splits continuous long strings without breaking UTF-16 surrogate pairs", () => {
    const continuous = "X".repeat(9000);
    const chunks = splitTelegramMessageText(continuous);
    expect(chunks.map((c) => c.length)).toEqual([4096, 4096, 808]);
    expect(chunks.join("")).toBe(continuous);

    // Surrogate pair ("🚀" = 2 UTF-16 code units) placed right across boundary index 9..10 (maxLength = 10)
    const rocket = "\uD83D\uDE80";
    const textWithPairAtBoundary = `${"a".repeat(9)}${rocket}${"b".repeat(5)}`;
    const emojiChunks = splitTelegramMessageText(textWithPairAtBoundary, 10);
    for (const chunk of emojiChunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
      // Verify no lone surrogates exist in any chunk
      expect(chunk.isWellFormed()).toBe(true);
    }
    expect(emojiChunks.join("")).toBe(textWithPairAtBoundary);
  });

  it("rejects empty text or invalid maxLength", () => {
    expect(() => splitTelegramMessageText("")).toThrow(ConnectorValidationError);
    expect(() => splitTelegramMessageText("hello", 1)).toThrow(ConnectorValidationError);
  });
});
