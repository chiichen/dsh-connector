export const CONNECTOR_CORE_VERSION = "0.1.0";

export {
  ConnectorAuthError,
  ConnectorError,
  ConnectorTargetRequiredError,
  ConnectorTransportError,
  ConnectorValidationError,
  type ConnectorErrorCode,
  type ConnectorErrorOptions,
  type ConnectorTransportErrorOptions,
} from "./errors.js";

export {
  assertNonEmptyContextId,
  assertValidConnectorName,
  createConnectorContext,
  createDefaultContextIdGenerator,
  extractContextMarker,
  isNonEmptyContextId,
  isValidConnectorName,
  prependContextMarker,
} from "./context.js";

export {
  defineConnector,
  isBidirectionalConnector,
  isReceivableConnector,
  isSendableConnector,
  isWebhookConnector,
} from "./guards.js";

export type {
  AnyConnector,
  BidirectionalConnector,
  ConnectorBase,
  ConnectorContext,
  ConnectorContextId,
  ConnectorContextIdGenerator,
  ConnectorInboundPrompt,
  ConnectorLogger,
  ConnectorName,
  ConnectorOnReceive,
  ConnectorRuntimeContext,
  ConnectorSendOptions,
  ConnectorSendResult,
  ConnectorWebhookRequest,
  ConnectorWebhookResponse,
  ContextMarkerStyle,
  InboundDeliveryMeta,
  ReceivableConnector,
  ReceiveCapability,
  ReceiveOnlyConnector,
  SendableConnector,
  SendCapability,
  SendOnlyConnector,
  WebhookConnector,
} from "./types.js";
