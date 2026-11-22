export const CONNECTOR_CORE_VERSION: string = "0.1.0";

export {
  ConnectorAuthError,
  ConnectorError,
  ConnectorTargetRequiredError,
  ConnectorTransportError,
  ConnectorValidationError,
  type ConnectorErrorCode,
  type ConnectorErrorOptions,
  type ConnectorTransportErrorOptions,
} from "./errors";

export {
  assertNonEmptyContextId,
  assertValidConnectorName,
  createConnectorContext,
  createDefaultContextIdGenerator,
  extractContextMarker,
  isNonEmptyContextId,
  isValidConnectorName,
  prependContextMarker,
} from "./context";

export {
  defineConnector,
  type Connector,
  type ConnectorContext,
  type ConnectorContextId,
  type ConnectorContextIdGenerator,
  type ConnectorInboundPrompt,
  type ConnectorLogger,
  type ConnectorName,
  type ConnectorObjectSchema,
  type ConnectorOnReceive,
  type ConnectorReceiver,
  type ConnectorReceiverContext,
  type ConnectorSender,
  type ConnectorSendOptions,
  type ConnectorSendResult,
  type ConnectorWebhookRequest,
  type ConnectorWebhookResponse,
  type ContextMarkerStyle,
  type InboundDeliveryMeta,
} from "./types";
