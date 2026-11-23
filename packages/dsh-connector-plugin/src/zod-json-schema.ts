/**
 * Lowers arbitrary Zod v4 schemas (`ConnectorSender.schema`) into the closed
 * JSON Schema subset enforced by `@deepseek-ai/dsh-tools` (`ObjectJsonSchema` /
 * `assertObjectJsonSchema`) and `@deepseek-ai/dsh-tool-executor-ptc` (`jsonSchemaToTs`).
 *
 * Why this adapter exists instead of passing `z.toJSONSchema(schema)` raw:
 * - Zod's `z.toJSONSchema()` emits Draft 2020-12 keywords (`$schema`, `$defs`/`$ref`,
 *   `anyOf`, multi-type arrays such as `["string", "null"]`, and refinement keywords
 *   such as `minLength`, `maxLength`, `format`, `pattern`, `minimum`, `maximum`).
 * - DSH's strict schema validator (`assertSupportedJsonSchema` / `assertObjectJsonSchema`)
 *   rejects any keyword outside `type` (single string), `oneOf`, `properties`, `required`,
 *   boolean `additionalProperties`, `items`, scalar `enum`/`const`, and annotations; in
 *   PTC mode (`jsonSchemaToTs`), unsupported keywords cause the generated TypeScript
 *   tool parameter signature to degrade to `unknown`.
 * - Full runtime input validation (including `minLength`, `regex`, `refine`, etc.) still
 *   runs via `sender.schema.safeParse(rawParams)` inside `ConnectorManager.dispatchSend`.
 */

import {
  assertObjectJsonSchema,
  type JsonSchemaNode,
  type JsonSchemaScalar,
  type JsonSchemaType,
  type ObjectJsonSchema,
} from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import { z } from "zod";
import { ConnectorValidationError } from "@dsh-connector/core";

const VALID_TYPES = new Set<string>([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

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

function isJsonScalar(value: unknown): value is JsonSchemaScalar {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}

function isLosslessJsonValue(value: unknown): value is JsonValue {
  if (isJsonScalar(value)) return true;
  if (Array.isArray(value)) return value.every(isLosslessJsonValue);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).every(isLosslessJsonValue);
  }
  return false;
}

function extractAnnotations(raw: Record<string, unknown>): JsonSchemaNode {
  const hints: string[] = [];
  for (const key of CONSTRAINT_HINT_KEYS) {
    const val = raw[key];
    if (val !== undefined) {
      hints.push(`${key}: ${String(val)}`);
    }
  }

  const baseDesc = typeof raw["description"] === "string" ? raw["description"] : undefined;
  const hintSuffix = hints.length > 0 ? `(${hints.join(", ")})` : undefined;
  const description =
    baseDesc !== undefined && hintSuffix !== undefined
      ? `${baseDesc} ${hintSuffix}`
      : (baseDesc ?? hintSuffix);

  const out: JsonSchemaNode = {};
  if (description !== undefined) out.description = description;
  if (typeof raw["title"] === "string") out.title = raw["title"];
  if ("default" in raw && raw["default"] !== undefined && isLosslessJsonValue(raw["default"])) {
    out.default = raw["default"];
  }
  if (Array.isArray(raw["examples"]) && isLosslessJsonValue(raw["examples"])) {
    out.examples = raw["examples"];
  }
  return out;
}

function resolveRef(
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
  return typeof target === "object" && target !== null && !Array.isArray(target)
    ? (target as Record<string, unknown>)
    : undefined;
}

function deduplicateBranches(branches: readonly JsonSchemaNode[]): JsonSchemaNode[] {
  const seen = new Set<string>();
  const unique: JsonSchemaNode[] = [];
  for (const branch of branches) {
    const flattened =
      branch.oneOf !== undefined &&
      branch.description === undefined &&
      branch.title === undefined &&
      branch.default === undefined
        ? branch.oneOf
        : [branch];
    for (const item of flattened) {
      const sig = JSON.stringify(item);
      if (!seen.has(sig)) {
        seen.add(sig);
        unique.push(item);
      }
    }
  }
  return unique;
}

function inferScalarType(val: JsonSchemaScalar): JsonSchemaType {
  if (val === null) return "null";
  if (typeof val === "string") return "string";
  if (typeof val === "number") return "number";
  return "boolean";
}

function normalizeNode(
  rawNode: unknown,
  defs: Readonly<Record<string, unknown>>,
  visitedRefs: ReadonlySet<string>,
): JsonSchemaNode {
  if (typeof rawNode !== "object" || rawNode === null || Array.isArray(rawNode)) {
    return {};
  }

  const raw = rawNode as Record<string, unknown>;
  const annotations = extractAnnotations(raw);

  if (typeof raw["$ref"] === "string") {
    const ref = raw["$ref"];
    if (visitedRefs.has(ref)) {
      return { ...annotations };
    }
    const resolved = resolveRef(ref, defs);
    if (resolved !== undefined) {
      const nextVisited = new Set(visitedRefs);
      nextVisited.add(ref);
      const inner = normalizeNode(resolved, defs, nextVisited);
      return { ...inner, ...annotations };
    }
    return { ...annotations };
  }

  const rawUnion = Array.isArray(raw["oneOf"])
    ? (raw["oneOf"] as unknown[])
    : Array.isArray(raw["anyOf"])
      ? (raw["anyOf"] as unknown[])
      : undefined;

  if (rawUnion !== undefined) {
    const branches = deduplicateBranches(rawUnion.map((b) => normalizeNode(b, defs, visitedRefs)));
    if (branches.length === 0) {
      return { ...annotations };
    }
    if (branches.length === 1) {
      return { ...branches[0]!, ...annotations };
    }
    return { ...annotations, oneOf: branches };
  }

  if (Array.isArray(raw["type"])) {
    const typeList = (raw["type"] as unknown[]).filter(
      (t): t is JsonSchemaType => typeof t === "string" && VALID_TYPES.has(t),
    );
    const branches = deduplicateBranches(
      typeList.map((t) => {
        if (t === "null") return { type: "null" } satisfies JsonSchemaNode;
        const clone: Record<string, unknown> = { ...raw, type: t };
        delete clone["description"];
        delete clone["title"];
        delete clone["default"];
        delete clone["examples"];
        for (const k of CONSTRAINT_HINT_KEYS) delete clone[k];
        return normalizeNode(clone, defs, visitedRefs);
      }),
    );
    if (branches.length === 0) return { ...annotations };
    if (branches.length === 1) return { ...branches[0]!, ...annotations };
    return { ...annotations, oneOf: branches };
  }

  if ("const" in raw && isJsonScalar(raw["const"])) {
    const val = raw["const"];
    const inferredType: JsonSchemaType =
      typeof raw["type"] === "string" && VALID_TYPES.has(raw["type"])
        ? (raw["type"] as JsonSchemaType)
        : inferScalarType(val);
    return {
      ...annotations,
      type: inferredType,
      const: val,
    };
  }

  if (Array.isArray(raw["enum"]) && raw["enum"].length > 0 && raw["enum"].every(isJsonScalar)) {
    const enumValues = raw["enum"];
    const firstType = inferScalarType(enumValues[0]!);
    const allSameScalarType = enumValues.every((v) => inferScalarType(v) === firstType);
    const explicitType =
      typeof raw["type"] === "string" && VALID_TYPES.has(raw["type"])
        ? (raw["type"] as JsonSchemaType)
        : allSameScalarType
          ? firstType
          : undefined;
    if (explicitType !== undefined) {
      return {
        ...annotations,
        type: explicitType,
        enum: enumValues,
      };
    }
    const literalBranches = deduplicateBranches(
      enumValues.map((v) => ({ type: inferScalarType(v), const: v })),
    );
    return literalBranches.length === 1
      ? { ...literalBranches[0]!, ...annotations }
      : { ...annotations, oneOf: literalBranches };
  }

  const rawType =
    typeof raw["type"] === "string" && VALID_TYPES.has(raw["type"])
      ? (raw["type"] as JsonSchemaType)
      : typeof raw["properties"] === "object" && raw["properties"] !== null
        ? "object"
        : undefined;

  if (rawType === "object") {
    const rawProps =
      typeof raw["properties"] === "object" &&
      raw["properties"] !== null &&
      !Array.isArray(raw["properties"])
        ? (raw["properties"] as Record<string, unknown>)
        : {};
    const properties: Record<string, JsonSchemaNode> = {};
    for (const [propKey, propVal] of Object.entries(rawProps)) {
      properties[propKey] = normalizeNode(propVal, defs, visitedRefs);
    }

    const required = Array.isArray(raw["required"])
      ? (raw["required"] as unknown[]).filter(
          (k): k is string => typeof k === "string" && k in properties,
        )
      : undefined;

    const additionalProperties =
      typeof raw["additionalProperties"] === "boolean"
        ? raw["additionalProperties"]
        : raw["additionalProperties"] !== undefined
          ? true
          : false;

    return {
      ...annotations,
      type: "object",
      properties,
      ...(required !== undefined && required.length > 0 ? { required } : {}),
      additionalProperties,
    };
  }

  if (rawType === "array") {
    const rawItems = raw["items"];
    let items: JsonSchemaNode | undefined;
    if (Array.isArray(rawItems)) {
      const itemBranches = deduplicateBranches(
        rawItems.map((it) => normalizeNode(it, defs, visitedRefs)),
      );
      items =
        itemBranches.length === 0
          ? undefined
          : itemBranches.length === 1
            ? itemBranches[0]!
            : { oneOf: itemBranches };
    } else if (rawItems !== undefined) {
      items = normalizeNode(rawItems, defs, visitedRefs);
    }
    return {
      ...annotations,
      type: "array",
      ...(items !== undefined ? { items } : {}),
    };
  }

  if (rawType !== undefined) {
    return {
      ...annotations,
      type: rawType,
    };
  }

  // Annotation-only schema node is DSH's canonical unconstrained JsonValue representation.
  return { ...annotations };
}

/**
 * Compile a `ConnectorSender.schema` (`z.ZodType`) into an `@deepseek-ai/dsh-tools`
 * `ObjectJsonSchema` validated by DSH's own `assertObjectJsonSchema`.
 */
export function zodToDshJsonSchema<TSchema extends z.ZodType>(schema: TSchema): ObjectJsonSchema {
  const rawRoot = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<string, unknown>;
  const defs: Record<string, unknown> = {
    ...(typeof rawRoot["definitions"] === "object" && rawRoot["definitions"] !== null
      ? (rawRoot["definitions"] as Record<string, unknown>)
      : {}),
    ...(typeof rawRoot["$defs"] === "object" && rawRoot["$defs"] !== null
      ? (rawRoot["$defs"] as Record<string, unknown>)
      : {}),
  };

  const normalized = normalizeNode(rawRoot, defs, new Set());
  if (normalized.type !== "object") {
    throw new ConnectorValidationError(
      `DSH Agent tool parameters require an object root schema (received "${normalized.type ?? "non-object"}").`,
    );
  }

  const candidate: ObjectJsonSchema = {
    ...normalized,
    type: "object",
    properties: normalized.properties ?? {},
  };
  assertObjectJsonSchema(candidate);
  return candidate;
}
