import { createHash, timingSafeEqual } from "node:crypto";
import { ConnectorValidationError } from "@dsh-connector/core";
import {
  TELEGRAM_SECRET_TOKEN_MAX_LENGTH,
  TELEGRAM_SECRET_TOKEN_MIN_LENGTH,
  TELEGRAM_SECRET_TOKEN_PATTERN,
  TELEGRAM_WEBHOOK_SECRET_HEADER,
} from "./constants";

const HASH_ALGORITHM_SHA256 = "sha256" as const;

/**
 * Validates a Telegram `setWebhook` `secret_token` (`1..256` characters matching `[A-Za-z0-9_-]`).
 *
 * @see https://core.telegram.org/bots/api#setwebhook
 */
export function assertValidWebhookSecretToken(secretToken: string, connectorName?: string): void {
  if (!TELEGRAM_SECRET_TOKEN_PATTERN.test(secretToken)) {
    throw new ConnectorValidationError(
      `Invalid Telegram webhookSecretToken: must be ${TELEGRAM_SECRET_TOKEN_MIN_LENGTH}..${TELEGRAM_SECRET_TOKEN_MAX_LENGTH} characters containing only [A-Za-z0-9_-].`,
      connectorName !== undefined ? { connectorName } : undefined,
    );
  }
}

function readCaseInsensitiveHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  expectedLowerName: string,
): string | undefined {
  for (const [key, rawValue] of Object.entries(headers)) {
    if (key.toLowerCase() !== expectedLowerName) {
      continue;
    }
    if (typeof rawValue === "string") {
      return rawValue;
    }
    if (Array.isArray(rawValue) && rawValue.length === 1 && typeof rawValue[0] === "string") {
      return rawValue[0];
    }
    return undefined;
  }
  return undefined;
}

/**
 * Verifies the `X-Telegram-Bot-Api-Secret-Token` HTTP request header in constant time.
 * Both tokens are hashed with SHA-256 prior to `crypto.timingSafeEqual` so inputs of unequal
 * length neither throw nor leak the configured secret's length via timing side-channels.
 *
 * @see https://core.telegram.org/bots/api#setwebhook
 */
export function verifyTelegramWebhookSecretToken(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  expectedSecretToken: string,
): boolean {
  if (expectedSecretToken.length === 0) {
    return false;
  }

  const provided = readCaseInsensitiveHeader(headers, TELEGRAM_WEBHOOK_SECRET_HEADER);
  if (provided === undefined || provided.length === 0) {
    return false;
  }

  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expectedSecretToken, "utf8");

  const providedDigest = createHash(HASH_ALGORITHM_SHA256).update(providedBytes).digest();
  const expectedDigest = createHash(HASH_ALGORITHM_SHA256).update(expectedBytes).digest();

  const digestsMatch = timingSafeEqual(providedDigest, expectedDigest);
  return digestsMatch && providedBytes.byteLength === expectedBytes.byteLength;
}
