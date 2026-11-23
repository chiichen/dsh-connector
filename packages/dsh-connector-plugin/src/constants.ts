/**
 * Package-scoped named constants for `dsh-connector-plugin`.
 * Cross-package protocol constants (such as `CONNECTOR_CONTEXT_SEPARATOR`) live in `@dsh-connector/core`.
 */

export const CONNECTOR_PLUGIN_NAME = "dsh-connector-plugin" as const;

export const CONNECTOR_STORAGE_DOMAIN_NAME = "dsh_connector_contexts" as const;
export const CONNECTOR_STORAGE_DOMAIN_VERSION = 1 as const;
export const CONNECTOR_STORAGE_TABLE_NAME = "contexts" as const;

export const DEFAULT_TOOL_NAME_PREFIX = "connector_send_" as const;

export const DEFAULT_WEBHOOK_BASE_PATH = "/webhooks/connectors" as const;
export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const WEBHOOK_OVERFLOW_DRAIN_MULTIPLIER = 4;

export const DEFAULT_DEDUPLICATION_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_DEDUPLICATION_MAX_ENTRIES = 4_096;

export const HTTP_STATUS_NOT_FOUND = 404;
export const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413;
export const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;

export const CONTENT_TYPE_TEXT_PLAIN = "text/plain; charset=utf-8" as const;
