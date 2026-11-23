import { describe, expect, it } from "vitest";
import { WHATSAPP_MAX_TEXT_LENGTH } from "../src/constants";
import { splitWhatsAppText } from "../src/chunker";
import {
  computeWhatsAppSignature,
  getHeaderCaseInsensitive,
  verifyHubVerifyToken,
  verifyWhatsAppSignature,
} from "../src/signature";

describe("Meta Webhook signature & verify_token validation", () => {
  const secret = "meta-app-secret-123";
  const rawBody = new TextEncoder().encode('{"object":"whatsapp_business_account","entry":[]}');

  it("computes and verifies valid X-Hub-Signature-256 HMAC-SHA256 signatures", () => {
    const sig = computeWhatsAppSignature(rawBody, secret);
    expect(sig.startsWith("sha256=")).toBe(true);
    expect(sig.length).toBe("sha256=".length + 64);

    expect(verifyWhatsAppSignature(rawBody, sig, secret)).toBe(true);
    expect(
      verifyWhatsAppSignature(rawBody, sig.toUpperCase().replace("SHA256=", "sha256="), secret),
    ).toBe(true);
    expect(verifyWhatsAppSignature(rawBody, [sig], secret)).toBe(true);
  });

  it("rejects missing, malformed, or tampered X-Hub-Signature-256 headers", () => {
    const validSig = computeWhatsAppSignature(rawBody, secret);
    const tamperedBody = new TextEncoder().encode(
      '{"object":"whatsapp_business_account","entry":[1]}',
    );

    expect(verifyWhatsAppSignature(tamperedBody, validSig, secret)).toBe(false);
    expect(verifyWhatsAppSignature(rawBody, validSig, "wrong-secret")).toBe(false);
    expect(verifyWhatsAppSignature(rawBody, undefined, secret)).toBe(false);
    expect(verifyWhatsAppSignature(rawBody, [], secret)).toBe(false);
    expect(verifyWhatsAppSignature(rawBody, "", secret)).toBe(false);
    expect(verifyWhatsAppSignature(rawBody, "sha1=abcdef", secret)).toBe(false);
    expect(verifyWhatsAppSignature(rawBody, "sha256=short", secret)).toBe(false);
    expect(verifyWhatsAppSignature(rawBody, `sha256=${"z".repeat(64)}`, secret)).toBe(false);
    expect(verifyWhatsAppSignature(rawBody, validSig, "")).toBe(false);
  });

  it("performs constant-time verification of hub.verify_token", () => {
    expect(verifyHubVerifyToken("meatyhamhock", "meatyhamhock")).toBe(true);
    expect(verifyHubVerifyToken("wrong", "meatyhamhock")).toBe(false);
    expect(verifyHubVerifyToken("meatyhamhock-extra", "meatyhamhock")).toBe(false);
    expect(verifyHubVerifyToken(null, "meatyhamhock")).toBe(false);
    expect(verifyHubVerifyToken(undefined, "meatyhamhock")).toBe(false);
    expect(verifyHubVerifyToken("meatyhamhock", undefined)).toBe(false);
    expect(verifyHubVerifyToken("", "")).toBe(false);
  });

  it("looks up HTTP headers case-insensitively", () => {
    const headers = {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": "sha256=abc",
    };
    expect(getHeaderCaseInsensitive(headers, "x-hub-signature-256")).toBe("sha256=abc");
    expect(
      getHeaderCaseInsensitive({ "x-hub-signature-256": "sha256=fast" }, "x-hub-signature-256"),
    ).toBe("sha256=fast");
    expect(getHeaderCaseInsensitive(headers, "x-missing")).toBeUndefined();
  });
});

describe("WhatsApp 4096-character text chunking", () => {
  it("returns single-element array when text fits within WHATSAPP_MAX_TEXT_LENGTH", () => {
    const exact = "a".repeat(WHATSAPP_MAX_TEXT_LENGTH);
    expect(splitWhatsAppText(exact)).toEqual([exact]);
  });

  it("splits long text preferring paragraph, newline, and space boundaries", () => {
    const para1 = "First paragraph ".repeat(150).trim();
    const para2 = "Second paragraph ".repeat(150).trim();
    const combined = `${para1}\n\n${para2}`;
    expect(combined.length).toBeGreaterThan(WHATSAPP_MAX_TEXT_LENGTH);

    const chunks = splitWhatsAppText(combined);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(WHATSAPP_MAX_TEXT_LENGTH);
    }

    const line1 = "L".repeat(70);
    const line2 = "M".repeat(70);
    const byLine = splitWhatsAppText(`${line1}\n${line2}`, 100);
    expect(byLine).toEqual([line1, line2]);

    const word1 = "W".repeat(70);
    const word2 = "X".repeat(70);
    const bySpace = splitWhatsAppText(`${word1} ${word2}`, 100);
    expect(bySpace).toEqual([word1, word2]);
  });

  it("never splits UTF-16 surrogate pairs (emojis) across chunk boundaries", () => {
    // Each 😀 is 2 UTF-16 code units; maxLength = 5 lands right inside the 3rd emoji!
    const emojis = "😀😀😀😀";
    const chunks = splitWhatsAppText(emojis, 5);
    expect(chunks).toEqual(["😀😀", "😀😀"]);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(5);
      expect(chunk.isWellFormed()).toBe(true);
    }
  });

  it("closes and reopens fenced code blocks across chunks when splitting inside code", () => {
    const codeLines = Array.from({ length: 120 }, (_, idx) => `const value_${idx} = ${idx};`).join(
      "\n",
    );
    const markdown = `\`\`\`ts\n${codeLines}\n\`\`\``;
    const chunks = splitWhatsAppText(markdown, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
      expect(chunk.startsWith("```ts\n")).toBe(true);
      expect(chunk.endsWith("```")).toBe(true);
    }

    // Closed code fence before split point should NOT reopen in next chunk
    const closedThenProse = `\`\`\`js\nconst x = 1;\n\`\`\`\n\n${"Plain prose sentence. ".repeat(25)}`;
    const closedChunks = splitWhatsAppText(closedThenProse, 200);
    expect(closedChunks.length).toBeGreaterThan(1);
    expect(closedChunks[1]?.startsWith("```")).toBe(false);
  });

  it("handles hard ASCII cuts and maxLength=1 boundaries", () => {
    expect(splitWhatsAppText("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
    expect(splitWhatsAppText("ab", 1)).toEqual(["a", "b"]);
  });

  it("rejects empty text or invalid maxLength", () => {
    expect(() => splitWhatsAppText("")).toThrow();
    expect(() => splitWhatsAppText("hello", 0)).toThrow();
    expect(() => splitWhatsAppText("hello", -5)).toThrow();
  });
});
