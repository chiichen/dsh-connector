/**
 * Declaratively lowers Zod v4 schemas (`ConnectorSender.schema`) into the closed
 * JSON Schema subset enforced by `@deepseek-ai/dsh-tools` (`ObjectJsonSchema` /
 * `assertObjectJsonSchema`) and `@deepseek-ai/dsh-tool-executor-ptc` (`jsonSchemaToTs`).
 *
 * Architecture:
 * 1. `dshJsonSchemaNodeSchema` and `dshObjectJsonSchema` define declarative Zod v4
 *    schemas equivalent to `@deepseek-ai/dsh-tools`'s `JsonSchemaNode` and
 *    `ObjectJsonSchema`, locked at compile time via bidirectional `AssertExactType`
 *    checks (without manual `: z.ZodType<ObjectJsonSchema>` type erasure).
 * 2. Unknown Draft 2020-12 keywords (`$schema`, `$defs`, `minLength`, `format`,
 *    `pattern`, `propertyNames`, etc.), lossless JSON checks (`z.json()`), and
 *    schema-valued `additionalProperties` coercion (`{ ... } -> true`) are handled
 *    declaratively by the Zod object schema itself.
 * 3. `preprocessDraftJsonSchemaRoot` handles only the Draft 2020-12 -> DSH dialect
 *    structural rewrites (`$ref` inlining, folding validation bounds into
 *    `description`, lowering `anyOf` / type-arrays / tuples / heterogeneous `enum`
 *    into deduplicated `oneOf` branches, and filtering `required` to `properties`).
 */

import {
  assertObjectJsonSchema,
  type JsonSchemaNode,
  type JsonSchemaScalar,
  type JsonSchemaType,
  type ObjectJsonSchema,
} from "@deepseek-ai/dsh-tools";
import { isJsonValue } from "@deepseek-ai/dsh-util-values";
import { z } from "zod";
import { ConnectorValidationError } from "@dsh-connector/core";

type Simplify<T> = { [K in keyof T]: T[K] };

/**
 * Compile-time bidirectional exact type equality assertion.
 * Fails compilation on any added/removed optional property, type drift, or `any`.
 */
export type AssertExactType<Actual, Expected> =
  (<T>() => T extends Simplify<Actual> ? 1 : 2) extends <T>() => T extends Simplify<Expected>
    ? 1
    : 2
    ? [Actual, Expected] extends [Expected, Actual]
      ? true
      : never
    : never;

const JSON_POINTER_DEFS_PREFIX = "#/$defs/";
const JSON_POINTER_DEFINITIONS_PREFIX = "#/definitions/";

const CONSTRAINT_HINT_KEYS = [
  "format",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
] as const;

const DSH_RETAINED_SIGNATURE_KEYS = [
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
] as const;

export const jsonSchemaScalarSchema = z.union([
  z.string(),
  z.number().refine((n) => Number.isFinite(n) && !Object.is(n, -0)),
  z.boolean(),
  z.null(),
]);

export const jsonSchemaTypeSchema = z.enum([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const losslessJsonValueSchema = z.json().refine(isJsonValue);

const dshJsonSchemaNodeShapeSchema = z.object({
  type: jsonSchemaTypeSchema.optional(),
  get oneOf() {
    return z.array(dshJsonSchemaNodeShapeSchema).min(2).optional();
  },
  get properties() {
    return z.record(z.string(), dshJsonSchemaNodeShapeSchema).optional();
  },
  required: z.array(z.string()).optional(),
  additionalProperties: z
    .union([z.boolean(), z.record(z.string(), z.unknown()).transform(() => true)])
    .optional(),
  get items() {
    return dshJsonSchemaNodeShapeSchema.optional();
  },
  enum: z.array(jsonSchemaScalarSchema).min(1).optional(),
  const: jsonSchemaScalarSchema.optional(),
  description: z.string().optional(),
  title: z.string().optional(),
  default: losslessJsonValueSchema.optional(),
  examples: losslessJsonValueSchema.optional(),
});

const dshObjectJsonSchemaShapeSchema = dshJsonSchemaNodeShapeSchema.extend({
  type: z.literal("object"),
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inferScalarType(val: JsonSchemaScalar): JsonSchemaType {
  if (val === null) return "null";
  if (typeof val === "string") return "string";
  if (typeof val === "number") return "number";
  return "boolean";
}

function buildDescriptionWithHints(raw: Readonly<Record<string, unknown>>): string | undefined {
  const isIntegerNode = raw["type"] === "integer";
  const hints: string[] = [];
  for (const key of CONSTRAINT_HINT_KEYS) {
    const val = raw[key];
    if (val === undefined) continue;
    if (isIntegerNode && key === "minimum" && val === Number.MIN_SAFE_INTEGER) continue;
    if (isIntegerNode && key === "maximum" && val === Number.MAX_SAFE_INTEGER) continue;
    hints.push(`${key}: ${String(val)}`);
  }
  const baseDesc = typeof raw["description"] === "string" ? raw["description"] : undefined;
  const hintSuffix = hints.length > 0 ? `(${hints.join(", ")})` : undefined;
  return baseDesc !== undefined && hintSuffix !== undefined
    ? `${baseDesc} ${hintSuffix}`
    : (baseDesc ?? hintSuffix);
}

function pickAnnotationFields(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const description = buildDescriptionWithHints(raw);
  if (description !== undefined) out["description"] = description;
  if (raw["title"] !== undefined) out["title"] = raw["title"];
  if (raw["default"] !== undefined) out["default"] = raw["default"];
  if (raw["examples"] !== undefined) out["examples"] = raw["examples"];
  return out;
}

function resolveRefTarget(
  ref: string,
  defs: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  let key: string | undefined;
  if (ref.startsWith(JSON_POINTER_DEFS_PREFIX)) {
    key = decodeURIComponent(ref.slice(JSON_POINTER_DEFS_PREFIX.length));
  } else if (ref.startsWith(JSON_POINTER_DEFINITIONS_PREFIX)) {
    key = decodeURIComponent(ref.slice(JSON_POINTER_DEFINITIONS_PREFIX.length));
  }
  if (key === undefined) return undefined;
  const target = defs[key];
  return isPlainRecord(target) ? target : undefined;
}

function projectedSignature(branch: Readonly<Record<string, unknown>>): string {
  const projected: Record<string, unknown> = {};
  for (const key of DSH_RETAINED_SIGNATURE_KEYS) {
    if (key in branch && branch[key] !== undefined) {
      projected[key] =
        key === "additionalProperties" && isPlainRecord(branch[key]) ? true : branch[key];
    }
  }
  return JSON.stringify(projected);
}

function deduplicateBranches(
  branches: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const unique: Record<string, unknown>[] = [];
  for (const branch of branches) {
    const flattened =
      Array.isArray(branch["oneOf"]) &&
      branch["description"] === undefined &&
      branch["title"] === undefined &&
      branch["default"] === undefined &&
      branch["examples"] === undefined
        ? (branch["oneOf"] as Record<string, unknown>[])
        : [branch];
    for (const item of flattened) {
      const sig = projectedSignature(item);
      if (!seen.has(sig)) {
        seen.add(sig);
        unique.push(item);
      }
    }
  }
  return unique;
}

function collapseUnionBranches(
  branches: readonly Record<string, unknown>[],
  annotations: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const unique = deduplicateBranches(branches);
  if (unique.length === 0) return { ...annotations };
  if (unique.length === 1) return { ...unique[0]!, ...annotations };
  return { ...annotations, oneOf: unique };
}

function preprocessDraftNode(
  rawNode: unknown,
  defs: Readonly<Record<string, unknown>>,
  visitedRefs: ReadonlySet<string>,
): Record<string, unknown> {
  if (!isPlainRecord(rawNode)) {
    return {};
  }

  const annotations = pickAnnotationFields(rawNode);

  if (typeof rawNode["$ref"] === "string") {
    const ref = rawNode["$ref"];
    if (visitedRefs.has(ref)) return annotations;
    const resolved = resolveRefTarget(ref, defs);
    if (resolved === undefined) return annotations;
    const nextVisited = new Set(visitedRefs);
    nextVisited.add(ref);
    return { ...preprocessDraftNode(resolved, defs, nextVisited), ...annotations };
  }

  const rawUnion = Array.isArray(rawNode["oneOf"])
    ? (rawNode["oneOf"] as unknown[])
    : Array.isArray(rawNode["anyOf"])
      ? (rawNode["anyOf"] as unknown[])
      : undefined;
  if (rawUnion !== undefined) {
    return collapseUnionBranches(
      rawUnion.map((branch) => preprocessDraftNode(branch, defs, visitedRefs)),
      annotations,
    );
  }

  if (Array.isArray(rawNode["type"])) {
    const validTypes = (rawNode["type"] as unknown[]).filter(
      (entry): entry is JsonSchemaType => jsonSchemaTypeSchema.safeParse(entry).success,
    );
    const branches = validTypes.map((typeEntry) => {
      if (typeEntry === "null") return { type: "null" };
      const clone: Record<string, unknown> = { ...rawNode, type: typeEntry };
      delete clone["description"];
      delete clone["title"];
      delete clone["default"];
      delete clone["examples"];
      for (const hintKey of CONSTRAINT_HINT_KEYS) delete clone[hintKey];
      return preprocessDraftNode(clone, defs, visitedRefs);
    });
    return collapseUnionBranches(branches, annotations);
  }

  if ("const" in rawNode) {
    const parsedScalar = jsonSchemaScalarSchema.safeParse(rawNode["const"]);
    if (parsedScalar.success) {
      const explicitType = jsonSchemaTypeSchema.safeParse(rawNode["type"]);
      return {
        ...rawNode,
        ...annotations,
        type: explicitType.success ? explicitType.data : inferScalarType(parsedScalar.data),
      };
    }
  }

  if (Array.isArray(rawNode["enum"]) && rawNode["enum"].length > 0) {
    const scalarList = z.array(jsonSchemaScalarSchema).safeParse(rawNode["enum"]);
    if (scalarList.success) {
      const values = scalarList.data;
      const firstType = inferScalarType(values[0]!);
      const allSameType = values.every((entry) => inferScalarType(entry) === firstType);
      const explicitType = jsonSchemaTypeSchema.safeParse(rawNode["type"]);
      if (explicitType.success || allSameType) {
        return {
          ...rawNode,
          ...annotations,
          type: explicitType.success ? explicitType.data : firstType,
        };
      }
      return collapseUnionBranches(
        values.map((entry) => ({ type: inferScalarType(entry), const: entry })),
        annotations,
      );
    }
  }

  const parsedType = jsonSchemaTypeSchema.safeParse(rawNode["type"]);
  const resolvedType: JsonSchemaType | undefined = parsedType.success
    ? parsedType.data
    : isPlainRecord(rawNode["properties"])
      ? "object"
      : undefined;

  if (resolvedType === "object") {
    const rawProps = isPlainRecord(rawNode["properties"]) ? rawNode["properties"] : {};
    const properties: Record<string, Record<string, unknown>> = {};
    for (const [key, propSchema] of Object.entries(rawProps)) {
      properties[key] = preprocessDraftNode(propSchema, defs, visitedRefs);
    }

    const required = Array.isArray(rawNode["required"])
      ? (rawNode["required"] as unknown[]).filter(
          (key): key is string => typeof key === "string" && Object.hasOwn(properties, key),
        )
      : undefined;

    const out: Record<string, unknown> = {
      ...rawNode,
      ...annotations,
      type: "object",
      properties,
      additionalProperties:
        rawNode["additionalProperties"] !== undefined ? rawNode["additionalProperties"] : false,
    };
    if (required !== undefined && required.length > 0) {
      out["required"] = required;
    } else {
      delete out["required"];
    }
    return out;
  }

  if (resolvedType === "array") {
    const rawPrefixItems = Array.isArray(rawNode["prefixItems"])
      ? (rawNode["prefixItems"] as unknown[])
      : undefined;
    const rawItems = rawNode["items"];

    let items: Record<string, unknown> | undefined;
    if (rawPrefixItems !== undefined) {
      const candidates = [...rawPrefixItems, ...(isPlainRecord(rawItems) ? [rawItems] : [])];
      items = collapseUnionBranches(
        candidates.map((entry) => preprocessDraftNode(entry, defs, visitedRefs)),
        {},
      );
    } else if (Array.isArray(rawItems)) {
      items = collapseUnionBranches(
        rawItems.map((entry) => preprocessDraftNode(entry, defs, visitedRefs)),
        {},
      );
    } else if (isPlainRecord(rawItems)) {
      items = preprocessDraftNode(rawItems, defs, visitedRefs);
    }

    const out: Record<string, unknown> = {
      ...rawNode,
      ...annotations,
      type: "array",
    };
    if (items !== undefined && Object.keys(items).length > 0) {
      out["items"] = items;
    } else {
      delete out["items"];
    }
    return out;
  }

  if (resolvedType !== undefined) {
    return {
      ...rawNode,
      ...annotations,
      type: resolvedType,
    };
  }

  // Annotation-only node represents unconstrained JsonValue in @deepseek-ai/dsh-tools.
  return annotations;
}

function preprocessDraftJsonSchemaRoot(input: unknown): unknown {
  if (!isPlainRecord(input)) {
    return input;
  }
  const defs: Record<string, unknown> = {
    ...(isPlainRecord(input["definitions"]) ? input["definitions"] : {}),
    ...(isPlainRecord(input["$defs"]) ? input["$defs"] : {}),
  };
  return preprocessDraftNode(input, defs, new Set());
}

const rawDshJsonSchemaNodeSchema = z.preprocess(
  preprocessDraftJsonSchemaRoot,
  dshJsonSchemaNodeShapeSchema,
);

const rawDshObjectJsonSchema = z.preprocess(
  preprocessDraftJsonSchemaRoot,
  dshObjectJsonSchemaShapeSchema,
);

const _assertScalarMatchesDsh: AssertExactType<
  z.output<typeof jsonSchemaScalarSchema>,
  JsonSchemaScalar
> = true;
const _assertTypeMatchesDsh: AssertExactType<
  z.output<typeof jsonSchemaTypeSchema>,
  JsonSchemaType
> = true;
const _assertNodeMatchesDsh: AssertExactType<
  z.output<typeof rawDshJsonSchemaNodeSchema>,
  JsonSchemaNode
> = true;
const _assertObjectMatchesDsh: AssertExactType<
  z.output<typeof rawDshObjectJsonSchema>,
  ObjectJsonSchema
> = true;
void _assertScalarMatchesDsh;
void _assertTypeMatchesDsh;
void _assertNodeMatchesDsh;
void _assertObjectMatchesDsh;

/**
 * Declarative Zod schema equivalent to `@deepseek-ai/dsh-tools`'s `JsonSchemaNode`.
 */
export const dshJsonSchemaNodeSchema: z.ZodType<JsonSchemaNode, unknown> =
  rawDshJsonSchemaNodeSchema;

/**
 * Declarative Zod schema equivalent to `@deepseek-ai/dsh-tools`'s `ObjectJsonSchema`.
 */
export const dshObjectJsonSchema: z.ZodType<ObjectJsonSchema, unknown> = rawDshObjectJsonSchema;

/**
 * Compile a `ConnectorSender.schema` (`z.ZodType`) into an `@deepseek-ai/dsh-tools`
 * `ObjectJsonSchema` via `z.toJSONSchema` + `dshObjectJsonSchema`.
 */
export function zodToDshJsonSchema<TSchema extends z.ZodType>(schema: TSchema): ObjectJsonSchema {
  const rawDraftSchema = z.toJSONSchema(schema, {
    unrepresentable: "any",
    reused: "inline",
  });

  const parsed = dshObjectJsonSchema.safeParse(rawDraftSchema);
  if (!parsed.success) {
    throw new ConnectorValidationError(
      `DSH Agent tool parameters require a valid object root schema: ${z.prettifyError(parsed.error)}`,
    );
  }

  assertObjectJsonSchema(parsed.data);
  return parsed.data;
}
