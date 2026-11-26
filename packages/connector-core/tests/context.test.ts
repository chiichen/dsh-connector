import { describe, expect, it } from "vitest";
import {
  assertNonEmptyContextId,
  assertValidConnectorName,
  BRACKET_CONTEXT_PREFIX,
  BRACKET_CONTEXT_SUFFIX,
  CONNECTOR_CONTEXT_SEPARATOR,
  createConnectorContext,
  createDefaultContextIdGenerator,
  contextIdFromMessageId,
  extractContextMarker,
  HTML_COMMENT_CONTEXT_PREFIX,
  MESSAGE_CONTEXT_ID_PREFIX,
  resolveInboundContextId,
  HTML_COMMENT_CONTEXT_SUFFIX,
  isNonEmptyContextId,
  isValidConnectorName,
  MAX_CONNECTOR_NAME_LEN,
  MIN_CONNECTOR_NAME_LEN,
  prependContextMarker,
  ConnectorValidationError,
  type Connector,
  type ConnectorContextId,
} from "../src";

describe("ConnectorName validation", () => {
  it("exports shared protocol constants for delimiter, name bounds, and context markers", () => {
    expect(CONNECTOR_CONTEXT_SEPARATOR).toBe("--");
    expect(MIN_CONNECTOR_NAME_LEN).toBe(2);
    expect(MAX_CONNECTOR_NAME_LEN).toBe(32);
    expect(HTML_COMMENT_CONTEXT_PREFIX).toBe("<!-- dsh-ctx:");
    expect(HTML_COMMENT_CONTEXT_SUFFIX).toBe(" -->");
    expect(BRACKET_CONTEXT_PREFIX).toBe("[#ctx:");
    expect(BRACKET_CONTEXT_SUFFIX).toBe("]");
  });

  it("accepts valid lowercase single-hyphen names", () => {
    for (const valid of ["tapd", "github", "wecom", "gongfeng-git", "tapd-v2", "a1-b2-c3"]) {
      expect(isValidConnectorName(valid)).toBe(true);
      expect(() => assertValidConnectorName(valid)).not.toThrow();
    }
  });

  it("rejects empty, uppercase, double-hyphen (--), special chars, and out-of-range names", () => {
    const invalidNames = [
      "",
      "a",
      "Tapd",
      "tapd--v2",
      "-tapd",
      "tapd-",
      "tapd_v2",
      "tapd:v2",
      "tapd.v2",
      "1tapd",
      "a".repeat(33),
    ];
    for (const invalid of invalidNames) {
      expect(isValidConnectorName(invalid)).toBe(false);
      expect(() => assertValidConnectorName(invalid)).toThrow(ConnectorValidationError);
    }
  });
});

describe("ConnectorContextId validation", () => {
  it("accepts non-empty unprefixed domain IDs including slashes, colons, hashes, and --", () => {
    const validIds = [
      "10086",
      "2001/story/10086",
      "chiichen/dsh-connector#42",
      "C01:172000.123",
      "proj--sub--99",
      "550e8400-e29b-41d4-a716-446655440000",
    ];
    for (const id of validIds) {
      expect(isNonEmptyContextId(id)).toBe(true);
      expect(() => assertNonEmptyContextId(id)).not.toThrow();
    }
  });

  it("rejects empty, whitespace-only, or multiline control strings", () => {
    for (const invalid of ["", "   ", "\t", "id\nwith-newline", "id\rwith-cr", "id\0null"]) {
      expect(isNonEmptyContextId(invalid)).toBe(false);
      expect(() => assertNonEmptyContextId(invalid)).toThrow(ConnectorValidationError);
    }
  });
});

describe("createConnectorContext & stateless JSON serialization", () => {
  const dummyConnector: Connector<"tapd"> = {
    name: "tapd",
    getSender: () => undefined,
    getReceiver: () => undefined,
  };

  it("creates frozen pure-JSON serializable context from connector instance or name", () => {
    const fromInstance = createConnectorContext(dummyConnector, "2001/story/10086");
    const fromName = createConnectorContext("tapd", "2001/story/10086");

    expect(Object.isFrozen(fromInstance)).toBe(true);
    expect(fromInstance).toEqual({
      connectorName: "tapd",
      contextId: "2001/story/10086",
    });
    expect(fromName).toEqual(fromInstance);
    expect(Object.keys(fromInstance)).toEqual(["connectorName", "contextId"]);

    const roundTripped = JSON.parse(JSON.stringify(fromInstance));
    expect(roundTripped).toEqual(fromInstance);

    expect(() => {
      (fromInstance as { contextId: string }).contextId = "mutated";
    }).toThrow(TypeError);
  });

  it("throws ConnectorValidationError when connectorName or contextId is invalid", () => {
    expect(() => createConnectorContext("tapd--bad", "100")).toThrow(ConnectorValidationError);
    expect(() => createConnectorContext("tapd", "")).toThrow(ConnectorValidationError);
    expect(() => createConnectorContext("tapd", "   ")).toThrow(ConnectorValidationError);
  });
});

describe("createDefaultContextIdGenerator", () => {
  it("generates unprefixed non-empty UUIDv4 identifiers", () => {
    const generator = createDefaultContextIdGenerator();
    const id1 = generator.generate("tapd");
    const id2 = generator.generate("tapd");

    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(id1).not.toContain("tapd");
    expect(id1).not.toBe(id2);
  });
});

describe("prependContextMarker & extractContextMarker", () => {
  const sampleId = "550e8400-e29b-41d4-a716-446655440000" as ConnectorContextId;

  it("encodes and extracts html-comment markers cleanly", () => {
    const encoded = prependContextMarker("Please review this PR.", sampleId, "html-comment");
    expect(encoded).toBe(`<!-- dsh-ctx:${sampleId} -->\nPlease review this PR.`);

    const extracted = extractContextMarker(encoded);
    expect(extracted.contextId).toBe(sampleId);
    expect(extracted.cleanedContent).toBe("Please review this PR.");
  });

  it("encodes and extracts compact bracket markers for plain-text IM platforms", () => {
    const encoded = prependContextMarker("Deploy finished.", sampleId, "bracket");
    expect(encoded).toBe(`[#ctx:${sampleId}]\nDeploy finished.`);

    const extracted = extractContextMarker(encoded);
    expect(extracted.contextId).toBe(sampleId);
    expect(extracted.cleanedContent).toBe("Deploy finished.");
  });

  it("is idempotent when called on content that already starts with a marker", () => {
    const first = prependContextMarker("Hello world", "old-id" as ConnectorContextId, "bracket");
    const second = prependContextMarker(first, sampleId, "html-comment");
    expect(second).toBe(`<!-- dsh-ctx:${sampleId} -->\nHello world`);
  });

  it("extracts contextId from Markdown quote replies and strips marker lines", () => {
    const quotedReply = [
      `> <!-- dsh-ctx:${sampleId} -->`,
      "> Should we add a lock here?",
      "",
      "Yes, please add a mutex!",
    ].join("\n");

    const result = extractContextMarker(quotedReply);
    expect(result.contextId).toBe(sampleId);
    expect(result.cleanedContent).toBe("> Should we add a lock here?\n\nYes, please add a mutex!");
  });

  it("prioritizes the shallowest quote level in nested multi-turn quote chains", () => {
    const nestedQuote = [
      "> > [#ctx:older-ancestor-id]",
      "> > Initial question",
      "> [#ctx:direct-parent-id]",
      "> Follow-up answer",
      "",
      "Final confirmation",
    ].join("\n");

    const result = extractContextMarker(nestedQuote);
    expect(result.contextId).toBe("direct-parent-id");
    expect(result.cleanedContent).not.toContain("#ctx:");
    expect(result.cleanedContent).toContain("Final confirmation");
  });

  it("round-trips tricky contextIds containing --> or ] without breaking marker syntax", () => {
    const trickyId = "special]-->[id" as ConnectorContextId;
    const htmlEncoded = prependContextMarker("Body", trickyId, "html-comment");
    expect(extractContextMarker(htmlEncoded)).toEqual({
      contextId: trickyId,
      cleanedContent: "Body",
    });

    const bracketEncoded = prependContextMarker("Body", trickyId, "bracket");
    expect(extractContextMarker(bracketEncoded)).toEqual({
      contextId: trickyId,
      cleanedContent: "Body",
    });
  });

  it("returns undefined contextId and untouched text when no marker exists", () => {
    const plain = "Just a normal user comment without any marker.";
    expect(extractContextMarker(plain)).toEqual({
      contextId: undefined,
      cleanedContent: plain,
    });
  });

  it("handles default style, empty bodies, malformed URI escapes, whitespace tokens, and deeper trailing quotes", () => {
    const defaultStyled = prependContextMarker("Default style", sampleId);
    expect(defaultStyled).toBe(`<!-- dsh-ctx:${sampleId} -->\nDefault style`);

    const emptyBodyEncoded = prependContextMarker("", sampleId);
    expect(emptyBodyEncoded).toBe(`<!-- dsh-ctx:${sampleId} -->`);

    const replacedHeaderOnly = prependContextMarker("[#ctx:old-id]", sampleId);
    expect(replacedHeaderOnly).toBe(`<!-- dsh-ctx:${sampleId} -->`);

    const quotedFirstLine = prependContextMarker("> [#ctx:parent-id]\nChild reply", sampleId);
    expect(quotedFirstLine).toBe(`<!-- dsh-ctx:${sampleId} -->\n> [#ctx:parent-id]\nChild reply`);

    const malformedPercent = extractContextMarker("<!-- dsh-ctx:raw%ZZid -->\nKept line");
    expect(malformedPercent).toEqual({
      contextId: "raw%ZZid",
      cleanedContent: "Kept line",
    });

    const decodedWhitespaceOnly = extractContextMarker("<!-- dsh-ctx:%20%20 -->\nBody text");
    expect(decodedWhitespaceOnly).toEqual({
      contextId: undefined,
      cleanedContent: "Body text",
    });

    const shallowThenDeep = [
      "> [#ctx:shallow-winner]",
      "> > [#ctx:deeper-ignored]",
      "Reply text",
    ].join("\n");
    expect(extractContextMarker(shallowThenDeep)).toEqual({
      contextId: "shallow-winner",
      cleanedContent: "Reply text",
    });
  });
});

describe("inbound context id from message content or message id", () => {
  it("exports the shared message-id prefix and builds msg:<id> from this message", () => {
    expect(MESSAGE_CONTEXT_ID_PREFIX).toBe("msg:");
    expect(contextIdFromMessageId(" om_msg_1001 ")).toBe("msg:om_msg_1001");
    expect(contextIdFromMessageId("C012:1717171717.000200")).toBe("msg:C012:1717171717.000200");
  });

  it("rejects an empty or multi-line message id", () => {
    expect(() => contextIdFromMessageId("   ")).toThrow(ConnectorValidationError);
    expect(() => contextIdFromMessageId("line\nbreak")).toThrow(ConnectorValidationError);
  });

  it("reuses a marker in the body before one in quoted original text", () => {
    const resolved = resolveInboundContextId({
      messageId: "m-new",
      body: "[#ctx:from-body]",
      quotedTexts: ["[#ctx:from-quote]\nolder"],
    });
    expect(resolved).toBe("from-body");
  });

  it("reuses a marker that is only in quoted original text already on the payload", () => {
    const resolved = resolveInboundContextId({
      messageId: "m-new",
      body: "what about this?",
      quotedTexts: ["> [#ctx:quoted-session]\nprevious reply"],
    });
    expect(resolved).toBe("quoted-session");
  });

  it("keeps the shallowest marker when several quoted texts contain one", () => {
    const resolved = resolveInboundContextId({
      messageId: "m-new",
      body: "no marker here",
      quotedTexts: ["> > [#ctx:deeper]", "[#ctx:shallower]"],
    });
    expect(resolved).toBe("shallower");
  });

  it("builds a new id from this message id when no marker is present", () => {
    const first = resolveInboundContextId({
      messageId: "wamid.AAA",
      body: "hello",
      quotedTexts: ["wamid.ONLY-AN-ID"],
    });
    const second = resolveInboundContextId({
      messageId: "wamid.BBB",
      body: "hello again",
    });
    expect(first).toBe("msg:wamid.AAA");
    expect(second).toBe("msg:wamid.BBB");
    expect(first).not.toBe(second);
  });

  it("accepts an html-comment marker inside quoted text", () => {
    const resolved = resolveInboundContextId({
      messageId: "42",
      body: "reply",
      quotedTexts: ["<!-- dsh-ctx:html-session -->\nbot said"],
    });
    expect(resolved).toBe("html-session");
  });
});
