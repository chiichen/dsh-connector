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
 * Carries compile-time Connector type affinity without holding a runtime Connector instance.
 */
export interface ConnectorContext<TConnector extends ConnectorBase = ConnectorBase> {
  readonly connectorName: TConnector["name"];
  readonly contextId: ConnectorContextId;
  readonly [CONNECTOR_TYPE_BRAND]?: TConnector;
}

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
  TConnector extends ConnectorBase = ConnectorBase,
> = (
  context: ConnectorContext<TConnector>,
  params: z.input<TReceiveSchema>,
  meta?: InboundDeliveryMeta,
) => Promise<{ readonly sessionId: string; readonly deduplicated?: boolean }>;

export interface ConnectorLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface ConnectorRuntimeContext<
  TReceiveSchema extends z.ZodType = z.ZodType,
  TConnector extends ConnectorBase = ConnectorBase,
> {
  readonly createContext: (contextId?: ConnectorContextId | string) => ConnectorContext<TConnector>;
  readonly contextIdGenerator: ConnectorContextIdGenerator;
  readonly onReceive?: ConnectorOnReceive<TReceiveSchema, TConnector>;
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

export interface ConnectorBase {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  init?(ctx: ConnectorRuntimeContext<any, any>): Promise<void> | void;
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
  handleWebhook?(req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse>;
}

export interface SendCapability<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TSendSchema extends z.ZodObject<any> = z.ZodObject<any>,
  TSendResult extends ConnectorSendResult = ConnectorSendResult,
  TConnector extends ConnectorBase = ConnectorBase,
> {
  readonly sendSchema: TSendSchema;
  readonly sendDescription?: string;
  send(
    context: ConnectorContext<TConnector>,
    params: z.output<TSendSchema>,
    options?: ConnectorSendOptions,
  ): Promise<TSendResult>;
}

export interface ReceiveCapability<
  TReceiveSchema extends z.ZodType = z.ZodType,
  TConnector extends ConnectorBase = ConnectorBase,
> {
  readonly receiveSchema: TReceiveSchema;
  init(ctx: ConnectorRuntimeContext<TReceiveSchema, TConnector>): Promise<void> | void;
  formatInbound?(
    params: z.output<TReceiveSchema>,
    context: ConnectorContext<TConnector>,
  ): ConnectorInboundPrompt | string;
}

export type SendOnlyConnector<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TSendSchema extends z.ZodObject<any> = z.ZodObject<any>,
  TSendResult extends ConnectorSendResult = ConnectorSendResult,
  TConnector extends ConnectorBase = ConnectorBase,
> = ConnectorBase &
  SendCapability<TSendSchema, TSendResult, TConnector> & {
    readonly receiveSchema?: undefined;
  };

export type ReceiveOnlyConnector<
  TReceiveSchema extends z.ZodType = z.ZodType,
  TConnector extends ConnectorBase = ConnectorBase,
> = ConnectorBase &
  ReceiveCapability<TReceiveSchema, TConnector> & {
    readonly sendSchema?: undefined;
    readonly send?: undefined;
  };

export type BidirectionalConnector<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TSendSchema extends z.ZodObject<any> = z.ZodObject<any>,
  TReceiveSchema extends z.ZodType = z.ZodType,
  TSendResult extends ConnectorSendResult = ConnectorSendResult,
  TConnector extends ConnectorBase = ConnectorBase,
> = ConnectorBase &
  SendCapability<TSendSchema, TSendResult, TConnector> &
  ReceiveCapability<TReceiveSchema, TConnector>;

/* eslint-disable @typescript-eslint/no-explicit-any */
export type SendableConnector =
  | SendOnlyConnector<any, any, any>
  | BidirectionalConnector<any, any, any, any>;

export type ReceivableConnector =
  | ReceiveOnlyConnector<any, any>
  | BidirectionalConnector<any, any, any, any>;

export type WebhookConnector = AnyConnector & {
  handleWebhook(req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse>;
};

export type AnyConnector =
  | SendOnlyConnector<any, any, any>
  | ReceiveOnlyConnector<any, any>
  | BidirectionalConnector<any, any, any, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */
