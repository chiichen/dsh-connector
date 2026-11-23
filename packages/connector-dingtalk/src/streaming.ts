import {
  ConnectorValidationError,
  type ConnectorContext,
  type ConnectorSendOptions,
} from "@dsh-connector/core";
import {
  DINGTALK_CARD_OPEN_SPACE_PREFIX,
  DINGTALK_CARD_SPACE_IM_GROUP,
  DINGTALK_CARD_SPACE_IM_ROBOT,
  DINGTALK_CARD_SPACE_IM_SINGLE,
  DINGTALK_CARD_SPACE_ONE_BOX,
} from "./constants";

/**
 * DingTalk Interactive / AI Card delivery space types.
 *
 * @see https://open.dingtalk.com/document/development/create-and-deliver-cards.md
 * @see https://open.dingtalk.com/document/orgapp/delivery-card-interface.md
 */
export type DingTalkCardSpaceType =
  | typeof DINGTALK_CARD_SPACE_IM_GROUP
  | typeof DINGTALK_CARD_SPACE_IM_ROBOT
  | typeof DINGTALK_CARD_SPACE_IM_SINGLE
  | typeof DINGTALK_CARD_SPACE_ONE_BOX;

/**
 * DingTalk Interactive Card callback transport modes (`STREAM` or `HTTP`, uppercase per spec).
 *
 * @see https://open.dingtalk.com/document/development/interface-for-creating-a-card-instance.md
 */
export type DingTalkCardCallbackType = "STREAM" | "HTTP";

/**
 * Target conversation descriptor for DingTalk AI Card / Interactive Card streaming.
 *
 * @see https://open.dingtalk.com/document/development/create-and-deliver-cards.md
 */
export type DingTalkStreamTarget =
  | {
      readonly kind: "user";
      readonly userId: string;
      readonly robotCode?: string;
    }
  | {
      readonly kind: "group";
      readonly openConversationId: string;
      readonly robotCode?: string;
      readonly atUserIds?: Readonly<Record<string, string>>;
    };

/**
 * Formats a unified DingTalk `openSpaceId` (`dtv1.card//IM_GROUP.<openConversationId>` or
 * `dtv1.card//IM_ROBOT.<userId>`) for card delivery APIs.
 *
 * @see https://open.dingtalk.com/document/development/create-and-deliver-cards.md
 * @see https://open.dingtalk.com/document/orgapp/delivery-card-interface.md
 */
export function formatDingTalkCardOpenSpaceId(target: DingTalkStreamTarget): string {
  if (target.kind === "group") {
    const openConversationId = target.openConversationId.trim();
    if (openConversationId.length === 0) {
      throw new ConnectorValidationError(
        "DingTalk group card target requires a non-empty openConversationId.",
      );
    }
    return `${DINGTALK_CARD_OPEN_SPACE_PREFIX}${DINGTALK_CARD_SPACE_IM_GROUP}.${openConversationId}`;
  }

  const userId = target.userId.trim();
  if (userId.length === 0) {
    throw new ConnectorValidationError("DingTalk user card target requires a non-empty userId.");
  }
  return `${DINGTALK_CARD_OPEN_SPACE_PREFIX}${DINGTALK_CARD_SPACE_IM_ROBOT}.${userId}`;
}

/**
 * Official payload contract for `POST /v1.0/card/instances` and
 * `POST /v1.0/card/instances/createAndDeliver`.
 *
 * @see https://open.dingtalk.com/document/development/interface-for-creating-a-card-instance.md
 * @see https://open.dingtalk.com/document/development/create-and-deliver-cards.md
 */
export interface DingTalkCreateCardInstanceRequest {
  readonly cardTemplateId: string;
  readonly outTrackId: string;
  readonly userId?: string;
  readonly userIdType?: 1 | 2;
  readonly callbackType?: DingTalkCardCallbackType;
  readonly callbackRouteKey?: string;
  readonly cardData: {
    readonly cardParamMap: Readonly<Record<string, string>>;
  };
  readonly privateData?: Readonly<
    Record<
      string,
      {
        readonly cardParamMap: Readonly<Record<string, string>>;
      }
    >
  >;
  readonly openSpaceId?: string;
  readonly cardAtUserIds?: readonly string[];
  readonly imGroupOpenSpaceModel?: {
    readonly supportForward: boolean;
    readonly lastMessageI18n?: Readonly<Record<string, string>>;
  };
  readonly imRobotOpenSpaceModel?: {
    readonly supportForward?: boolean;
    readonly lastMessageI18n?: Readonly<Record<string, string>>;
  };
  readonly imGroupOpenDeliverModel?: {
    readonly robotCode: string;
    readonly atUserIds?: Readonly<Record<string, string>>;
    readonly recipients?: readonly string[];
    readonly extension?: Readonly<Record<string, string>>;
  };
  readonly imRobotOpenDeliverModel?: {
    readonly spaceType?: typeof DINGTALK_CARD_SPACE_IM_ROBOT;
    readonly robotCode?: string;
    readonly extension?: Readonly<Record<string, string>>;
  };
}

/**
 * Official payload contract for `PUT /v1.0/card/streaming` (AI Card typewriter streaming update).
 * Note: Per DingTalk specification, when `key` is bound to a Markdown variable in the card template,
 * `isFull` MUST be `true` and `content` must carry the full accumulated Markdown text.
 *
 * @see https://open.dingtalk.com/document/development/api-streamingupdate.md
 * @see https://open.dingtalk.com/document/orgapp/api-streamingupdate.md
 */
export interface DingTalkCardStreamingUpdateRequest {
  readonly outTrackId: string;
  readonly guid: string;
  readonly key: string;
  readonly content: string;
  readonly isFull?: boolean;
  readonly isFinalize?: boolean;
  readonly isError?: boolean;
}

/**
 * Official response body for `PUT /v1.0/card/streaming`.
 *
 * @see https://open.dingtalk.com/document/development/api-streamingupdate.md
 */
export interface DingTalkCardStreamingUpdateResponse {
  readonly success?: boolean;
  readonly result?: boolean;
}

/**
 * Official payload contract for `PUT /v1.0/card/instances` (card state & variable update).
 *
 * @see https://open.dingtalk.com/document/development/card-update.md
 */
export interface DingTalkUpdateCardInstanceRequest {
  readonly outTrackId: string;
  readonly userIdType?: 1 | 2;
  readonly cardData?: {
    readonly cardParamMap: Readonly<Record<string, string>>;
  };
  readonly cardUpdateOptions?: {
    readonly updateCardDataByKey?: boolean;
    readonly updatePrivateDataByKey?: boolean;
  };
}

/**
 * Active DingTalk AI Card / Interactive Card stream session handle.
 */
export interface DingTalkStreamHandle {
  readonly outTrackId: string;
  readonly cardTemplateId: string;
  readonly openSpaceId: string;
  readonly streamKey: string;
  readonly target: DingTalkStreamTarget;
  readonly carrierId?: string;
}

export interface DingTalkStreamStartInput {
  readonly target: DingTalkStreamTarget;
  readonly cardTemplateId?: string;
  readonly streamKey?: string;
  readonly initialContent?: string;
  readonly cardParamMap?: Readonly<Record<string, string>>;
}

export interface DingTalkStreamUpdateInput {
  readonly content: string;
  readonly isFull?: boolean;
  readonly guid?: string;
}

export interface DingTalkStreamCompleteInput {
  readonly finalContent: string;
  readonly cardParamMap?: Readonly<Record<string, string>>;
  readonly guid?: string;
}

export interface DingTalkStreamAbortInput {
  readonly reason?: string;
  readonly errorContent?: string;
  readonly guid?: string;
}

/**
 * Reserved extension interface for DingTalk AI Card / Interactive Card streaming updates.
 * Note: Streaming execution is intentionally NOT implemented in this phase; this seam allows future
 * host-driven `ConnectorReplyHandler` / AI Card streaming adapters to plug in without breaking public APIs.
 *
 * @see https://open.dingtalk.com/document/development/interface-for-creating-a-card-instance.md
 * @see https://open.dingtalk.com/document/development/create-and-deliver-cards.md
 * @see https://open.dingtalk.com/document/development/api-streamingupdate.md
 */
export interface DingTalkStreamingAdapter<TName extends string = string> {
  startStream(
    context: ConnectorContext<TName>,
    input: DingTalkStreamStartInput,
    options?: ConnectorSendOptions,
  ): Promise<DingTalkStreamHandle>;

  updateStream(
    handle: DingTalkStreamHandle,
    input: DingTalkStreamUpdateInput,
    options?: ConnectorSendOptions,
  ): Promise<void>;

  completeStream(
    handle: DingTalkStreamHandle,
    input: DingTalkStreamCompleteInput,
    options?: ConnectorSendOptions,
  ): Promise<void>;

  abortStream(
    handle: DingTalkStreamHandle,
    input: DingTalkStreamAbortInput,
    options?: ConnectorSendOptions,
  ): Promise<void>;

  sendThinkingReaction?(
    target: {
      readonly robotCode: string;
      readonly openMsgId: string;
      readonly openConversationId: string;
    },
    options?: ConnectorSendOptions,
  ): Promise<void>;
}

/**
 * Reserved streaming configuration options on `DingTalkConnectorOptions`.
 *
 * @see https://open.dingtalk.com/document/development/api-streamingupdate.md
 */
export interface DingTalkStreamingOptions<TName extends string = string> {
  readonly cardTemplateId?: string;
  readonly streamKey?: string;
  readonly callbackType?: DingTalkCardCallbackType;
  readonly throttleIntervalMs?: number;
  readonly adapter?: DingTalkStreamingAdapter<TName>;
}
