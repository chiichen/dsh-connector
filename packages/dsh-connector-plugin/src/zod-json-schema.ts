import { z } from "zod";
import { ConnectorValidationError } from "@dsh-connector/core";

export type DshJsonPrimitiveType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

export interface DshJsonSchema {
  readonly type?: DshJsonPrimitiveType;
  readonly oneOf?: readonly DshJsonSchema[];
  readonly properties?: Readonly<Record<string, DshJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: DshJsonSchema;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly description?: string;
  readonly title?: string;
  readonly default?: unknown;
  readonly examples?: readonly unknown[];
}

export interface DshObjectJsonSchema extends DshJsonSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, DshJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

const VALID_TYPES = new Set<string>([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

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

function extractAnnotations(raw: Record<string, unknown>): Partial<DshJsonSchema> {
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

  const out: Record<string, unknown> = {};
  if (description !== undefined) out["description"] = description;
  if (typeof raw["title"] === "string") out["title"] = raw["title"];
  if ("default" in raw && raw["default"] !== undefined) out["default"] = raw["default"];
  if (Array.isArray(raw["examples"])) out["examples"] = raw["examples"];
  return out as Partial<DshJsonSchema>;
}

function resolveRef(
  ref: string,
  defs: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const prefixDefs = "#/$defs/";
  const prefixDefinitions = "#/definitions/";
  let key: string | undefined;
  if (ref.startsWith(prefixDefs)) {
    key = decodeURIComponent(ref.slice(prefixDefs.length));
  } else if (ref.startsWith(prefixDefinitions)) {
    key = decodeURIComponent(ref.slice(prefixDefinitions.length));
  }
  if (key === undefined) return undefined;
  const target = defs[key];
  return typeof target === "object" && target !== null && !Array.isArray(target)
    ? (target as Record<string, unknown>)
    : undefined;
}

function deduplicateBranches(branches: readonly DshJsonSchema[]): DshJsonSchema[] {
  const seen = new Set<string>();
  const unique: DshJsonSchema[] = [];
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

function fallbackAnySchema(annotations: Partial<DshJsonSchema>): DshJsonSchema {
  return {
    ...annotations,
    oneOf: [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      { type: "null" },
      { type: "object", additionalProperties: true },
      { type: "array", items: { type: "string" } },
    ],
  };
}

function normalizeNode(
  rawNode: unknown,
  defs: Readonly<Record<string, unknown>>,
  visitedRefs: ReadonlySet<string>,
): DshJsonSchema {
  if (typeof rawNode !== "object" || rawNode === null || Array.isArray(rawNode)) {
    return fallbackAnySchema({});
  }

  const raw = rawNode as Record<string, unknown>;
  const annotations = extractAnnotations(raw);

  if (typeof raw["$ref"] === "string") {
    const ref = raw["$ref"];
    if (visitedRefs.has(ref)) {
      return { ...annotations, type: "object", additionalProperties: true };
    }
    const resolved = resolveRef(ref, defs);
    if (resolved !== undefined) {
      const nextVisited = new Set(visitedRefs);
      nextVisited.add(ref);
      const inner = normalizeNode(resolved, defs, nextVisited);
      return { ...inner, ...annotations };
    }
    return fallbackAnySchema(annotations);
  }

  const rawUnion = Array.isArray(raw["oneOf"])
    ? (raw["oneOf"] as unknown[])
    : Array.isArray(raw["anyOf"])
      ? (raw["anyOf"] as unknown[])
      : undefined;

  if (rawUnion !== undefined) {
    const branches = deduplicateBranches(rawUnion.map((b) => normalizeNode(b, defs, visitedRefs)));
    if (branches.length === 0) {
      return fallbackAnySchema(annotations);
    }
    if (branches.length === 1) {
      return { ...branches[0]!, ...annotations };
    }
    return { ...annotations, oneOf: branches };
  }

  if (Array.isArray(raw["type"])) {
    const typeList = (raw["type"] as unknown[]).filter(
      (t): t is DshJsonPrimitiveType => typeof t === "string" && VALID_TYPES.has(t),
    );
    const branches = deduplicateBranches(
      typeList.map((t) => {
        if (t === "null") return { type: "null" } satisfies DshJsonSchema;
        const clone: Record<string, unknown> = { ...raw, type: t };
        delete clone["description"];
        delete clone["title"];
        delete clone["default"];
        delete clone["examples"];
        for (const k of CONSTRAINT_HINT_KEYS) delete clone[k];
        return normalizeNode(clone, defs, visitedRefs);
      }),
    );
    if (branches.length === 0) return fallbackAnySchema(annotations);
    if (branches.length === 1) return { ...branches[0]!, ...annotations };
    return { ...annotations, oneOf: branches };
  }

  if ("const" in raw && raw["const"] !== undefined) {
    const val = raw["const"];
    const inferredType: DshJsonPrimitiveType | undefined =
      typeof raw["type"] === "string" && VALID_TYPES.has(raw["type"])
        ? (raw["type"] as DshJsonPrimitiveType)
        : val === null
          ? "null"
          : typeof val === "string"
            ? "string"
            : typeof val === "number"
              ? "number"
              : typeof val === "boolean"
                ? "boolean"
                : undefined;
    return {
      ...annotations,
      ...(inferredType !== undefined ? { type: inferredType } : {}),
      const: val,
    };
  }

  if (Array.isArray(raw["enum"]) && raw["enum"].length > 0) {
    const enumValues = raw["enum"] as unknown[];
    const explicitType =
      typeof raw["type"] === "string" && VALID_TYPES.has(raw["type"])
        ? (raw["type"] as DshJsonPrimitiveType)
        : undefined;
    return {
      ...annotations,
      ...(explicitType !== undefined ? { type: explicitType } : {}),
      enum: enumValues,
    };
  }

  const rawType =
    typeof raw["type"] === "string" && VALID_TYPES.has(raw["type"])
      ? (raw["type"] as DshJsonPrimitiveType)
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
    const properties: Record<string, DshJsonSchema> = {};
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
    let items: DshJsonSchema;
    if (Array.isArray(rawItems)) {
      const itemBranches = deduplicateBranches(
        rawItems.map((it) => normalizeNode(it, defs, visitedRefs)),
      );
      items =
        itemBranches.length === 0
          ? { type: "string" }
          : itemBranches.length === 1
            ? itemBranches[0]!
            : { oneOf: itemBranches };
    } else if (rawItems !== undefined) {
      items = normalizeNode(rawItems, defs, visitedRefs);
    } else {
      items = { type: "string" };
    }
    return {
      ...annotations,
      type: "array",
      items,
    };
  }

  if (rawType !== undefined) {
    return {
      ...annotations,
      type: rawType,
    };
  }

  return fallbackAnySchema(annotations);
}

export function zodToDshJsonSchema<TSchema extends z.ZodType>(
  schema: TSchema,
): DshObjectJsonSchema {
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
      `DSH Agent tool parameters require an object root schema (received "${normalized.type ?? "union"}").`,
    );
  }

  return {
    ...normalized,
    type: "object",
    properties: normalized.properties ?? {},
  };
}
