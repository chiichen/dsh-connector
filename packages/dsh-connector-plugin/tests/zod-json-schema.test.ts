import { assertObjectJsonSchema, type ObjectJsonSchema } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConnectorValidationError } from "@dsh-connector/core";
import {
  CONNECTOR_PLUGIN_NAME,
  CONNECTOR_STORAGE_DOMAIN_NAME,
  CONNECTOR_STORAGE_TABLE_NAME,
  DEFAULT_DEDUPLICATION_MAX_ENTRIES,
  DEFAULT_DEDUPLICATION_TTL_MS,
  DEFAULT_TOOL_NAME_PREFIX,
  DEFAULT_WEBHOOK_BASE_PATH,
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
} from "../src/constants";
import { zodToDshJsonSchema } from "../src/zod-json-schema";

describe("plugin named constants", () => {
  it("defines non-empty named constants matching DSH storage unit naming rules", () => {
    expect(CONNECTOR_PLUGIN_NAME).toBe("dsh-connector-plugin");
    expect(CONNECTOR_STORAGE_DOMAIN_NAME).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(CONNECTOR_STORAGE_TABLE_NAME).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(DEFAULT_TOOL_NAME_PREFIX).toBe("connector_send_");
    expect(DEFAULT_WEBHOOK_BASE_PATH).toBe("/webhooks/connectors");
    expect(DEFAULT_WEBHOOK_MAX_BODY_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_DEDUPLICATION_TTL_MS).toBeGreaterThan(0);
    expect(DEFAULT_DEDUPLICATION_MAX_ENTRIES).toBeGreaterThan(0);
  });
});

describe("zodToDshJsonSchema", () => {
  it("lowers complex Zod v4 object schemas into @deepseek-ai/dsh-tools ObjectJsonSchema subset", () => {
    const complexSendSchema = z.object({
      repo: z.string().min(3).max(100).describe("Target owner/repo"),
      issueNumber: z.number().int().min(1).optional(),
      body: z.string().min(1),
      visibility: z.enum(["public", "internal"]).default("public"),
      reviewerEmail: z.string().email().nullable(),
      target: z.union([
        z.object({ kind: z.literal("pr"), prId: z.number().int() }),
        z.object({ kind: z.literal("commit"), sha: z.string().regex(/^[0-9a-f]{7,40}$/) }),
      ]),
      labels: z.array(z.string()).max(10).optional(),
      extraMeta: z.record(z.string(), z.unknown()).optional(),
      arbitraryPayload: z.unknown().describe("Arbitrary JSON metadata").optional(),
    });

    const dshSchema: ObjectJsonSchema = zodToDshJsonSchema(complexSendSchema);

    expect(() => assertObjectJsonSchema(dshSchema)).not.toThrow();
    expect(dshSchema.type).toBe("object");
    expect(dshSchema.required).toContain("repo");
    expect(dshSchema.required).toContain("body");
    expect(dshSchema.required).not.toContain("issueNumber");

    const repoSchema = dshSchema.properties?.["repo"];
    expect(repoSchema?.description).toContain("Target owner/repo");
    expect(repoSchema?.description).toContain("minLength: 3");

    const nullableEmail = dshSchema.properties?.["reviewerEmail"];
    expect(nullableEmail?.oneOf).toBeDefined();
    expect(nullableEmail?.type).toBeUndefined();

    // Unconstrained unknown/any lowers to DSH's annotation-only unconstrained JsonValue node
    const arbitraryPayload = dshSchema.properties?.["arbitraryPayload"];
    expect(arbitraryPayload).toEqual({ description: "Arbitrary JSON metadata" });
  });

  it("accepts refined z.ZodType object schemas and rejects non-object root schemas with ConnectorValidationError", () => {
    const refinedSchema: z.ZodType = z
      .object({
        targetId: z.string().min(1),
        message: z.string().min(1),
      })
      .refine((val) => val.message.trim().length > 0);

    const compiled = zodToDshJsonSchema(refinedSchema);
    expect(() => assertObjectJsonSchema(compiled)).not.toThrow();
    expect(compiled.type).toBe("object");
    expect(compiled.required).toEqual(["targetId", "message"]);

    expect(() => zodToDshJsonSchema(z.string())).toThrow(ConnectorValidationError);
  });
});
