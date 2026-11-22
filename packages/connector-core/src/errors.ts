export type ConnectorErrorCode =
  | "CONNECTOR_ERROR"
  | "CONNECTOR_VALIDATION_ERROR"
  | "CONNECTOR_TARGET_REQUIRED"
  | "CONNECTOR_AUTH_ERROR"
  | "CONNECTOR_TRANSPORT_ERROR";

export interface ConnectorErrorOptions {
  readonly code?: ConnectorErrorCode;
  readonly connectorName?: string;
  readonly cause?: unknown;
}

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly connectorName: string | undefined;

  constructor(message: string, options?: ConnectorErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options?.code ?? "CONNECTOR_ERROR";
    this.connectorName = options?.connectorName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ConnectorValidationError extends ConnectorError {
  constructor(message: string, options?: Omit<ConnectorErrorOptions, "code">) {
    super(message, { ...options, code: "CONNECTOR_VALIDATION_ERROR" });
  }
}

export class ConnectorTargetRequiredError extends ConnectorError {
  readonly targetField: string;

  constructor(
    connectorName: string,
    targetField: string,
    options?: Omit<ConnectorErrorOptions, "code" | "connectorName">,
  ) {
    super(
      `Connector "${connectorName}" requires an explicit target parameter "${targetField}" when the current session context does not identify a business target.`,
      { ...options, connectorName, code: "CONNECTOR_TARGET_REQUIRED" },
    );
    this.targetField = targetField;
  }
}

export class ConnectorAuthError extends ConnectorError {
  constructor(message: string, options?: Omit<ConnectorErrorOptions, "code">) {
    super(message, { ...options, code: "CONNECTOR_AUTH_ERROR" });
  }
}

export interface ConnectorTransportErrorOptions extends Omit<ConnectorErrorOptions, "code"> {
  readonly statusCode?: number;
  readonly retryable?: boolean;
}

export class ConnectorTransportError extends ConnectorError {
  readonly statusCode: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, options?: ConnectorTransportErrorOptions) {
    super(message, { ...options, code: "CONNECTOR_TRANSPORT_ERROR" });
    this.statusCode = options?.statusCode;
    this.retryable = options?.retryable ?? false;
  }
}
