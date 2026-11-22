import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodToDshJsonSchema, type DshJsonSchema } from "../src/zod-json-schema";

const ALLOWED_KEYWORDS = new Set([
  "type",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "default",
  "examples",
]);

const ALLOWED_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

function assertStrictDshSchema(node: unknown, path = "$"): void {
  expect(typeof node === "object" && node !== null && !Array.isArray(node)).toBe(true);
  const record = node as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      throw new Error(`Forbidden DSH JSON Schema keyword "${key}" at ${path}`);
    }
  }

  if ("type" in record) {
    expect(typeof record["type"]).toBe("string");
    expect(ALLOWED_TYPES.has(record["type"] as string)).toBe(true);
    expect("oneOf" in record).toBe(false);
  }

  if ("oneOf" in record) {
    expect(Array.isArray(record["oneOf"])).toBe(true);
    const branches = record["oneOf"] as unknown[];
    expect(branches.length).toBeGreaterThanOrEqual(2);
    branches.forEach((branch, idx) => assertStrictDshSchema(branch, `${path}.oneOf[${idx}]`));
  }

  if ("additionalProperties" in record) {
    expect(typeof record["additionalProperties"]).toBe("boolean");
  }

  if ("properties" in record) {
    const props = record["properties"] as Record<string, unknown>;
    for (const [propName, propSchema] of Object.entries(props)) {
      assertStrictDshSchema(propSchema, `${path}.properties.${propName}`);
    }
  }

  if ("items" in record) {
    assertStrictDshSchema(record["items"], `${path}.items`);
  }
}

describe("zodToDshJsonSchema", () => {
  it("compiles complex Zod v4 object schemas into 100% DSH-compliant strict JSON Schema", () => {
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
    });

    const dshSchema: DshJsonSchema = zodToDshJsonSchema(complexSendSchema);

    assertStrictDshSchema(dshSchema);
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
  });
});
