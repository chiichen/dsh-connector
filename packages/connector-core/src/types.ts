import type { z } from "zod";

declare const CONNECTOR_TYPE_BRAND: unique symbol;

/**
 * Validated unique connector identifier:
 * lowercase letter start, lowercase alphanumeric and single hyphens only (no `--`), 2..32 chars.
 */
export type ConnectorName = string & { readonly __brand: "ConnectorName" };

/**
 * Unprefixed, guaranteed non-empty context identifier local to a Connector.
 */
export type ConnectorContextId = string & { readonly __brand: "ConnectorContextId" };

/**
 * Stateless, directly JSON-serializable Connector context value object.
 * Parameterized on `TName` so `ConnectorContext<"tapd">` cannot be mixed with `ConnectorContext<"github">`.
 */
export interface ConnectorContext<TName extends string = string> {
  readonly connectorName: TName;
  readonly contextId: ConnectorContextId;
  readonly [CONNECTOR_TYPE_BRAND]?: TName;
}

/**
 * Covariant base constraint for Zod v4 object schemas without `any`.
 */
export type ConnectorObjectSchema = z.ZodObject<z.core.$ZodShape, z.core.$ZodObjectConfig>;

/**
 * Host-provided generator for non-empty unprefixed ConnectorContextId values (UUIDv4 by default).
 * Shared by both inbound `onReceive` fallback allocation and outbound-first `send` initialization.
 */
export interface ConnectorContextIdGenerator {
  generate(connectorName: string): ConnectorContextId;
}

export type ContextMarkerStyle = "html-comment" | "bracket";

export interface InboundDeliveryMeta {
  readonly idempotencyKey?: string;
  readonly suggestedTitle?: string;
  readonly receivedAt?: number;
  readonly deliveryMode?: "queue" | "steer";
}

export interface ConnectorInboundPrompt {
  readonly text: string;
  readonly title?: string;
}

export type ConnectorOnReceive<
  TReceiveSchema extends z.ZodType = z.ZodType,
  TName extends string = string,
> = (
  context: ConnectorContext<TName>,
  params: z.input<TReceiveSchema>,
  meta?: InboundDeliveryMeta,
) => Promise<{ readonly sessionId: string; readonly deduplicated?: boolean }>;

export interface ConnectorLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface ConnectorReceiverContext<
  TReceiveSchema extends z.ZodType = z.ZodType,
  TName extends string = string,
> {
  allocateContextId(): ConnectorContextId;
  readonly contextIdGenerator: ConnectorContextIdGenerator;
  readonly onReceive: ConnectorOnReceive<TReceiveSchema, TName>;
  readonly logger: ConnectorLogger;
}

export interface ConnectorWebhookRequest {
  readonly method: string;
  readonly pathname: string;
  readonly subPath: string;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly rawBody: Uint8Array;
}

export interface ConnectorWebhookResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

export interface ConnectorSendOptions {
  readonly signal?: AbortSignal;
}

export interface ConnectorSendResult {
  readonly externalId?: string;
  readonly summary?: string;
  readonly data?: Record<string, unknown>;
}

export interface ConnectorSender<
  TSchema extends ConnectorObjectSchema = ConnectorObjectSchema,
  TResult extends ConnectorSendResult = ConnectorSendResult,
  TName extends string = string,
> {
  readonly description?: string;
  readonly schema: TSchema;
  send(
    context: ConnectorContext<TName>,
    params: z.output<TSchema>,
    options?: ConnectorSendOptions,
  ): Promise<TResult>;
}

export interface ConnectorReceiver<
  TSchema extends z.ZodType = z.ZodType,
  TName extends string = string,
> {
  readonly schema: TSchema;
  init?(ctx: ConnectorReceiverContext<TSchema, TName>): Promise<void> | void;
  formatInbound?(
    params: z.output<TSchema>,
    context: ConnectorContext<TName>,
  ): ConnectorInboundPrompt | string;
  handleWebhook?(req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse>;
}

export interface Connector<
  TName extends string = string,
  TSendSchema extends ConnectorObjectSchema = ConnectorObjectSchema,
  TReceiveSchema extends z.ZodType = z.ZodType,
  TSendResult extends ConnectorSendResult = ConnectorSendResult,
> {
  readonly name: TName;
  readonly displayName?: string;
  readonly description?: string;

  getSender(): ConnectorSender<TSendSchema, TSendResult, TName> | undefined;
  getReceiver(): ConnectorReceiver<TReceiveSchema, TName> | undefined;

  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export function defineConnector<
  const TName extends string,
  TSendSchema extends ConnectorObjectSchema = ConnectorObjectSchema,
  TReceiveSchema extends z.ZodType = z.ZodType,
  TSendResult extends ConnectorSendResult = ConnectorSendResult,
>(
  connector: Connector<TName, TSendSchema, TReceiveSchema, TSendResult>,
): Connector<TName, TSendSchema, TReceiveSchema, TSendResult> {
  return connector;
}
