import Schema from "@deepseek-ai/schemastery";
import { PLATFORM_BY_ID } from "./catalog";
import type { PlatformDefinition, PlatformField } from "./types";

function fieldSchema(field: PlatformField): unknown {
  const description = field.description.en;
  switch (field.kind) {
    case "boolean":
      return Schema.boolean().description(description).required(false);
    case "number":
      return Schema.number().description(description).required(false);
    case "string-list":
      return Schema.array(Schema.string()).description(description).required(false);
    case "enum":
      return Schema.string()
        .description(`${description} One of: ${(field.choices ?? []).join(", ")}.`)
        .required(false);
    case "secret":
      return Schema.string().role("secret").description(description).required(false);
    case "string":
      return Schema.string().description(description).required(false);
  }
}

function platformObject(definition: PlatformDefinition) {
  const properties: Record<string, unknown> = {
    enabled: Schema.boolean()
      .default(false)
      .description(`Enable the ${definition.label.en} connector.`),
  };
  const nested = new Map<string, PlatformField[]>();

  for (const field of definition.fields) {
    const dot = field.key.indexOf(".");
    if (dot === -1) {
      properties[field.key] = fieldSchema(field);
      continue;
    }
    const head = field.key.slice(0, dot);
    const child: PlatformField = { ...field, key: field.key.slice(dot + 1) };
    const children = nested.get(head) ?? [];
    children.push(child);
    nested.set(head, children);
  }

  for (const [key, children] of nested) {
    const childProperties: Record<string, unknown> = {};
    for (const child of children) {
      childProperties[child.key] = fieldSchema(child);
    }
    properties[key] = Schema.object(childProperties as never)
      .description(key)
      .required(false);
  }

  return Schema.object(properties as never)
    .description(definition.description.en)
    .required(false);
}

export const platformSettingsSchema = Schema.object({
  feishu: platformObject(PLATFORM_BY_ID.feishu),
  weixin: platformObject(PLATFORM_BY_ID.weixin),
  dingtalk: platformObject(PLATFORM_BY_ID.dingtalk),
  wecom: platformObject(PLATFORM_BY_ID.wecom),
  qq: platformObject(PLATFORM_BY_ID.qq),
  slack: platformObject(PLATFORM_BY_ID.slack),
  telegram: platformObject(PLATFORM_BY_ID.telegram),
  discord: platformObject(PLATFORM_BY_ID.discord),
  whatsapp: platformObject(PLATFORM_BY_ID.whatsapp),
}).description(
  "Per-platform connector credentials. Enable a platform and fill the options that connector reads.",
);
