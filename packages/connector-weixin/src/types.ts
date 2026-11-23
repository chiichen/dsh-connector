import { z } from "zod";
import type { ConnectorSendResult, ContextMarkerStyle } from "@dsh-connector/core";
import type { DEFAULT_WEIXIN_CONNECTOR_NAME } from "./constants";
import type {
  WeixinAiMsgContext,
  WeixinStreamingAdapter,
  WeixinStreamingOptions,
} from "./streaming";

/**
 * Supported WeChat connector transport modes:
 * - `"official-account"`: Standard WeChat Official Account / Service Account / Mini Program Customer Service
 *   HTTP callback (SHA1 + `echostr` + optional AES-256-CBC) + `message/custom/send` outbound API.
 * - `"ilink"`: WeChat iLink Bot HTTPS long-polling (`getupdates` + `sendmessage`).
 *
 * @see https://developers.weixin.qq.com/doc/service/guide/dev/push/
 * @see https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html
 */
export type WeixinConnectorMode = "official-account" | "ilink";

/**
 * Outbound send schema for `@dsh-connector/connector-weixin`.
 *
 * Uses `text` as the primary required content field and keeps all target addressing fields optional
 * so host-driven session replies and explicit tool calls share a single contract.
 *
 * @see https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html
 */
export const weixinSendSchema = z.object({
  text: z.string().min(1),
  openId: z.string().min(1).optional(),
  toUserId: z.string().min(1).optional(),
  kfAccount: z.string().min(1).optional(),
  businessId: z.string().min(1).optional(),
  contextToken: z.string().min(1).optional(),
});

export type WeixinSendParams = z.output<typeof weixinSendSchema>;

/**
 * Normalized inbound message schema emitted to `ConnectorReceiverContext.onReceive`.
 *
 * @see https://developers.weixin.qq.com/doc/service/guide/product/message/Receiving_standard_messages.html
 */
export const weixinReceiveSchema = z.object({
  mode: z.enum(["official-account", "ilink"]),
  messageId: z.string().min(1),
  senderId: z.string().min(1),
  recipientId: z.string().min(1).optional(),
  msgType: z.enum(["text", "voice"]),
  text: z.string().min(1),
  createTimeMs: z.number().int().nonnegative().optional(),
  msgDataId: z.string().min(1).optional(),
  idx: z.string().min(1).optional(),
  quotedMessageId: z.string().min(1).optional(),
  quotedText: z.string().min(1).optional(),
  contextToken: z.string().min(1).optional(),
});

export type WeixinReceiveParams = z.output<typeof weixinReceiveSchema>;

/**
 * Structured send result preserving message IDs, recipient OpenID, mode, and raw API responses
 * for downstream diagnostics and future streaming/continuation adapters.
 */
export interface WeixinSendResult extends ConnectorSendResult {
  readonly messageId: string;
  readonly messageIds: readonly string[];
  readonly openId: string;
  readonly chunkCount: number;
  readonly mode: WeixinConnectorMode;
  readonly contextToken?: string;
  readonly raw: ReadonlyArray<Record<string, unknown>>;
}

export type WeixinTokenStrategy = "stable" | "classic";

export interface WeixinAccessTokenProviderOptions {
  readonly forceRefresh?: boolean;
  readonly signal?: AbortSignal;
}

export type WeixinAccessTokenProvider = (
  options?: WeixinAccessTokenProviderOptions,
) => Promise<string> | string;

export interface WeixinConnectorCommonOptions<
  TName extends string = typeof DEFAULT_WEIXIN_CONNECTOR_NAME,
> {
  readonly name?: TName;
  readonly displayName?: string;
  readonly description?: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxMessageChars?: number;
  readonly contextMarkerStyle?: ContextMarkerStyle | "none";
  readonly deduplicationMaxEntries?: number;
  readonly allowedSenderIds?: readonly string[];
  /**
   * Reserved streaming & typing configuration slot (not executed in non-streaming mode).
   */
  readonly streaming?: WeixinStreamingOptions;
  /**
   * Reserved streaming adapter instance exposed via `connector.getStreamingAdapter()`.
   */
  readonly streamingAdapter?: WeixinStreamingAdapter;
}

/**
 * Options for Official WeChat Official Account / Service Account / Customer Service mode.
 *
 * @see https://developers.weixin.qq.com/doc/service/guide/dev/push/
 * @see https://developers.weixin.qq.com/doc/oplatform/developers/dev/push/encryption.html
 * @see https://developers.weixin.qq.com/doc/service/api/base/api_getstableaccesstoken.html
 * @see https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html
 */
export interface WeixinOfficialAccountOptions<
  TName extends string = typeof DEFAULT_WEIXIN_CONNECTOR_NAME,
> extends WeixinConnectorCommonOptions<TName> {
  readonly mode?: "official-account";
  /** WeChat Official Account / Service Account `AppID` (`wx...`). */
  readonly appId: string;
  /** WeChat `AppSecret` used to obtain `access_token` when `accessToken`/`accessTokenProvider` is not supplied. */
  readonly appSecret?: string;
  /** Callback verification `Token` configured in WeChat Developer Platform. */
  readonly token: string;
  /** Optional 43-character `EncodingAESKey` for Safe / Compatible callback encryption modes. */
  readonly encodingAesKey?: string;
  /** Optional developer account original ID (e.g. `gh_xxxxxxxxxxxx`) used for strict self-message filtering. */
  readonly accountId?: string;
  /** Optional static `access_token` or `authorizer_access_token`. */
  readonly accessToken?: string;
  /** Optional custom `access_token` provider function. */
  readonly accessTokenProvider?: WeixinAccessTokenProvider;
  /** Token acquisition endpoint strategy: `"stable"` (`POST /cgi-bin/stable_token`, default) or `"classic"` (`GET /cgi-bin/token`). */
  readonly tokenStrategy?: WeixinTokenStrategy;
  /** Refresh safety margin in milliseconds before token expiry (default 300,000 ms / 5 min). */
  readonly tokenRefreshMarginMs?: number;
  /** Base URL for WeChat API calls (defaults to `https://api.weixin.qq.com`). */
  readonly apiBaseUrl?: string;
  /** Optional default Customer Service account (`customservice.kf_account`). */
  readonly kfAccount?: string;
  /** Optional sub-merchant `businessid` for `message/custom/send`. */
  readonly businessId?: string;
  /** Optional static `aimsgcontext` attached to `message/custom/send` requests. */
  readonly aiMsgContext?: WeixinAiMsgContext;
  /** Maximum UTF-8 bytes per chunk for `message/custom/send` (defaults to 2000, below WeChat's 2048-byte limit). */
  readonly maxMessageBytes?: number;
}

/**
 * Options for WeChat iLink Bot HTTPS long-polling mode (compatible with `xmanrui/dsh-im` Weixin channel).
 */
export interface WeixinIlinkOptions<
  TName extends string = typeof DEFAULT_WEIXIN_CONNECTOR_NAME,
> extends WeixinConnectorCommonOptions<TName> {
  readonly mode: "ilink";
  /** Bearer token (`ilink_bot_token`) obtained from WeChat iLink bot login. */
  readonly botToken: string;
  /** Base URL for iLink API requests (defaults to `https://ilinkai.weixin.qq.com/`). */
  readonly baseUrl?: string;
  /** Optional bot/self user identifier for self-message filtering. */
  readonly botUserId?: string;
  /** Long-polling request timeout in milliseconds (defaults to 35,000 ms). */
  readonly pollTimeoutMs?: number;
  /** Base retry backoff delay in milliseconds when polling encounters transient errors. */
  readonly pollRetryBaseDelayMs?: number;
  /** Maximum retry backoff delay in milliseconds when polling encounters transient errors. */
  readonly pollRetryMaxDelayMs?: number;
  /** Initial `get_updates_buf` cursor restored from external persistence. */
  readonly initialUpdatesBuf?: string;
  /** Optional hook invoked whenever `get_updates_buf` advances. */
  readonly onUpdatesBufChange?: (updatesBuf: string) => Promise<void> | void;
  /** Optional maximum UTF-8 bytes per chunk (defaults to 0 / disabled in iLink mode, bounded by `maxMessageChars`). */
  readonly maxMessageBytes?: number;
}

export type WeixinConnectorOptions<TName extends string = typeof DEFAULT_WEIXIN_CONNECTOR_NAME> =
  | WeixinOfficialAccountOptions<TName>
  | WeixinIlinkOptions<TName>;
