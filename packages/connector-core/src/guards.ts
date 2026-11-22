import type { z } from "zod";
import type {
  AnyConnector,
  BidirectionalConnector,
  ConnectorSendResult,
  ReceivableConnector,
  ReceiveOnlyConnector,
  SendableConnector,
  SendOnlyConnector,
  WebhookConnector,
} from "./types.js";

export function defineConnector<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TSendSchema extends z.ZodObject<any>,
  TReceiveSchema extends z.ZodType,
  TSendResult extends ConnectorSendResult = ConnectorSendResult,
>(
  connector: BidirectionalConnector<TSendSchema, TReceiveSchema, TSendResult>,
): BidirectionalConnector<TSendSchema, TReceiveSchema, TSendResult>;

export function defineConnector<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TSendSchema extends z.ZodObject<any>,
  TSendResult extends ConnectorSendResult = ConnectorSendResult,
>(
  connector: SendOnlyConnector<TSendSchema, TSendResult>,
): SendOnlyConnector<TSendSchema, TSendResult>;

export function defineConnector<TReceiveSchema extends z.ZodType>(
  connector: ReceiveOnlyConnector<TReceiveSchema>,
): ReceiveOnlyConnector<TReceiveSchema>;

export function defineConnector<T extends AnyConnector>(connector: T): T {
  return connector;
}

export function isSendableConnector(connector: AnyConnector): connector is SendableConnector {
  return (
    typeof connector === "object" &&
    connector !== null &&
    connector.sendSchema !== undefined &&
    typeof connector.send === "function"
  );
}

export function isReceivableConnector(connector: AnyConnector): connector is ReceivableConnector {
  return (
    typeof connector === "object" &&
    connector !== null &&
    connector.receiveSchema !== undefined &&
    typeof connector.init === "function"
  );
}

export function isBidirectionalConnector(
  connector: AnyConnector,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): connector is BidirectionalConnector<any, any, any, any> {
  return isSendableConnector(connector) && isReceivableConnector(connector);
}

export function isWebhookConnector(connector: AnyConnector): connector is WebhookConnector {
  return (
    typeof connector === "object" &&
    connector !== null &&
    typeof connector.handleWebhook === "function"
  );
}
