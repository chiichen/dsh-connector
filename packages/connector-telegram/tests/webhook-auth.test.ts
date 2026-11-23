import { ConnectorValidationError } from "@dsh-connector/core";
import { describe, expect, it } from "vitest";
import {
  assertValidWebhookSecretToken,
  verifyTelegramWebhookSecretToken,
} from "../src/webhook-auth";

describe("Telegram webhook X-Telegram-Bot-Api-Secret-Token verification", () => {
  const validSecret = "My_Secret-Token_2026_AbCdEfGh123456";

  it("validates setWebhook secret_token character and length constraints (1..256 [A-Za-z0-9_-])", () => {
    expect(() => assertValidWebhookSecretToken(validSecret, "telegram")).not.toThrow();
    expect(() => assertValidWebhookSecretToken("a", "telegram")).not.toThrow();
    expect(() => assertValidWebhookSecretToken("x".repeat(256), "telegram")).not.toThrow();

    expect(() => assertValidWebhookSecretToken("", "telegram")).toThrow(ConnectorValidationError);
    expect(() => assertValidWebhookSecretToken("x".repeat(257), "telegram")).toThrow(
      ConnectorValidationError,
    );
    expect(() => assertValidWebhookSecretToken("bad secret!", "telegram")).toThrow(
      ConnectorValidationError,
    );
  });

  it("verifies matching header case-insensitively and supports single-item string array headers", () => {
    expect(
      verifyTelegramWebhookSecretToken(
        { "x-telegram-bot-api-secret-token": validSecret },
        validSecret,
      ),
    ).toBe(true);

    expect(
      verifyTelegramWebhookSecretToken(
        { "X-Telegram-Bot-Api-Secret-Token": [validSecret] },
        validSecret,
      ),
    ).toBe(true);
  });

  it("rejects missing, empty, mismatched, different-length, and multi-valued headers safely", () => {
    expect(verifyTelegramWebhookSecretToken({}, validSecret)).toBe(false);
    expect(
      verifyTelegramWebhookSecretToken(
        { "x-telegram-bot-api-secret-token": undefined },
        validSecret,
      ),
    ).toBe(false);
    expect(
      verifyTelegramWebhookSecretToken({ "x-telegram-bot-api-secret-token": "" }, validSecret),
    ).toBe(false);
    expect(
      verifyTelegramWebhookSecretToken({ "x-telegram-bot-api-secret-token": "short" }, validSecret),
    ).toBe(false);
    expect(
      verifyTelegramWebhookSecretToken(
        { "x-telegram-bot-api-secret-token": `${validSecret}_extra` },
        validSecret,
      ),
    ).toBe(false);
    expect(
      verifyTelegramWebhookSecretToken(
        { "x-telegram-bot-api-secret-token": [validSecret, validSecret] },
        validSecret,
      ),
    ).toBe(false);
    expect(
      verifyTelegramWebhookSecretToken({ "x-telegram-bot-api-secret-token": validSecret }, ""),
    ).toBe(false);
  });
});
