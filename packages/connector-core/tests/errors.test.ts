import { describe, expect, it } from "vitest";
import {
  ConnectorAuthError,
  ConnectorError,
  ConnectorTargetRequiredError,
  ConnectorTransportError,
  ConnectorValidationError,
} from "../src/index.js";

describe("Connector error hierarchy", () => {
  it("preserves error inheritance, code, connectorName, and cause", () => {
    const rootCause = new Error("socket hang up");
    const transportErr = new ConnectorTransportError("Webhook request failed", {
      connectorName: "wecom",
      statusCode: 502,
      retryable: true,
      cause: rootCause,
    });

    expect(transportErr).toBeInstanceOf(Error);
    expect(transportErr).toBeInstanceOf(ConnectorError);
    expect(transportErr).toBeInstanceOf(ConnectorTransportError);
    expect(transportErr.code).toBe("CONNECTOR_TRANSPORT_ERROR");
    expect(transportErr.connectorName).toBe("wecom");
    expect(transportErr.statusCode).toBe(502);
    expect(transportErr.retryable).toBe(true);
    expect(transportErr.cause).toBe(rootCause);
  });

  it("formats ConnectorTargetRequiredError with connector and target field hints", () => {
    const err = new ConnectorTargetRequiredError("github", "issueNumber");
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe("CONNECTOR_TARGET_REQUIRED");
    expect(err.connectorName).toBe("github");
    expect(err.targetField).toBe("issueNumber");
    expect(err.message).toContain("github");
    expect(err.message).toContain("issueNumber");
  });

  it("constructs validation and auth errors with distinct stable error codes", () => {
    const valErr = new ConnectorValidationError("Invalid contextId", { connectorName: "tapd" });
    const authErr = new ConnectorAuthError("Invalid HMAC signature", { connectorName: "github" });

    expect(valErr.code).toBe("CONNECTOR_VALIDATION_ERROR");
    expect(authErr.code).toBe("CONNECTOR_AUTH_ERROR");
  });
});
