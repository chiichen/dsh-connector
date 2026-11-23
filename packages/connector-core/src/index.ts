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
  BRACKET_CONTEXT_PREFIX,
  BRACKET_CONTEXT_SUFFIX,
  CONNECTOR_CONTEXT_SEPARATOR,
  createConnectorContext,
  createDefaultContextIdGenerator,
  extractContextMarker,
  HTML_COMMENT_CONTEXT_PREFIX,
  HTML_COMMENT_CONTEXT_SUFFIX,
  isNonEmptyContextId,
  isValidConnectorName,
  MAX_CONNECTOR_NAME_LEN,
  MIN_CONNECTOR_NAME_LEN,
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
