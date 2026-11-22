import { z } from "zod";
import {
  ConnectorTargetRequiredError,
  createConnectorContext,
  extractContextMarker,
  prependContextMarker,
  type Connector,
  type ConnectorContext,
  type ConnectorObjectSchema,
  type ConnectorReceiver,
  type ConnectorReceiverContext,
  type ConnectorSender,
  type ConnectorSendResult,
  type ConnectorWebhookRequest,
  type ConnectorWebhookResponse,
  type InboundDeliveryMeta,
} from "@dsh-connector/core";

export const wecomSendSchema = z.object({
  webhookKey: z.string().min(1),
  text: z.string().min(1),
});

export class MockWecomNotifyConnector implements Connector<"wecom", typeof wecomSendSchema> {
  readonly name = "wecom" as const;
  readonly description = "Send notification to WeCom group bot";
  readonly sentCalls: Array<{
    context: ConnectorContext<"wecom">;
    params: z.output<typeof wecomSendSchema>;
  }> = [];

  private readonly sender: ConnectorSender<typeof wecomSendSchema, ConnectorSendResult, "wecom"> = {
    schema: wecomSendSchema,
    send: async (context, params) => {
      const encodedText = prependContextMarker(params.text, context.contextId, "bracket");
      this.sentCalls.push({ context, params: { ...params, text: encodedText } });
      return {
        externalId: `wecom-msg-${this.sentCalls.length}`,
        summary: `Sent to ${params.webhookKey}`,
      };
    },
  };

  getSender(): ConnectorSender<typeof wecomSendSchema, ConnectorSendResult, "wecom"> {
    return this.sender;
  }

  getReceiver(): undefined {
    return undefined;
  }
}

export const alertReceiveSchema = z.object({
  severity: z.enum(["warning", "critical"]),
  message: z.string(),
  fingerprint: z.string().optional(),
});

export class MockAlertIngestConnector implements Connector<
  "alertmanager",
  ConnectorObjectSchema,
  typeof alertReceiveSchema
> {
  readonly name = "alertmanager" as const;
  stopped = false;
  private receiverCtx?: ConnectorReceiverContext<typeof alertReceiveSchema, "alertmanager">;

  private readonly receiver: ConnectorReceiver<typeof alertReceiveSchema, "alertmanager"> = {
    schema: alertReceiveSchema,
    init: (ctx) => {
      this.receiverCtx = ctx;
    },
    handleWebhook: async (req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse> => {
      if (req.method === "GET" && req.query.has("echostr")) {
        return { status: 200, body: req.query.get("echostr") ?? "" };
      }
      if (req.headers["x-alert-token"] !== "secret-token") {
        return { status: 401, body: "Unauthorized" };
      }
      const bodyText = new TextDecoder().decode(req.rawBody);
      const parsed = JSON.parse(bodyText) as z.input<typeof alertReceiveSchema>;
      const deliveryId =
        typeof req.headers["x-delivery-id"] === "string" ? req.headers["x-delivery-id"] : undefined;
      const result = await this.simulateAlert(
        parsed,
        deliveryId !== undefined ? { idempotencyKey: deliveryId } : undefined,
      );
      return {
        status: 202,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result),
      };
    },
  };

  getSender(): undefined {
    return undefined;
  }

  getReceiver(): ConnectorReceiver<typeof alertReceiveSchema, "alertmanager"> {
    return this.receiver;
  }

  stop(): void {
    this.stopped = true;
  }

  async simulateAlert(
    payload: z.input<typeof alertReceiveSchema>,
    meta?: InboundDeliveryMeta,
  ): Promise<{ readonly sessionId: string; readonly deduplicated?: boolean }> {
    if (this.receiverCtx === undefined) {
      throw new Error("MockAlertIngestConnector not initialized");
    }
    const contextId =
      payload.fingerprint !== undefined
        ? `fp:${payload.fingerprint}`
        : this.receiverCtx.allocateContextId();
    const ctx = createConnectorContext(this, contextId);
    return this.receiverCtx.onReceive(ctx, payload, meta);
  }
}

export const githubSendSchema = z.object({
  repo: z.string().default("chiichen/dsh-connector"),
  prNumber: z.number().int().min(1).optional(),
  body: z.string().min(1),
});

export const githubReceiveSchema = z.object({
  repo: z.string(),
  prNumber: z.number().int().min(1),
  author: z.string(),
  commentBody: z.string(),
});

function parsePrFromContextId(contextId: string): { repo: string; prNumber: number } | undefined {
  const match = /^(?<repo>[a-z0-9_.-]+\/[a-z0-9_.-]+)#(?<num>\d+)$/i.exec(contextId);
  if (match?.groups === undefined) return undefined;
  return {
    repo: match.groups["repo"]!,
    prNumber: Number(match.groups["num"]!),
  };
}

export class MockGithubPrConnector implements Connector<
  "github",
  typeof githubSendSchema,
  typeof githubReceiveSchema
> {
  readonly name = "github" as const;
  readonly description = "Comment on GitHub pull requests and receive review comments";

  started = false;
  stopped = false;
  readonly postedComments: Array<{
    context: ConnectorContext<"github">;
    repo: string;
    prNumber: number;
    encodedBody: string;
  }> = [];

  private receiverCtx?: ConnectorReceiverContext<typeof githubReceiveSchema, "github">;

  private readonly sender: ConnectorSender<typeof githubSendSchema, ConnectorSendResult, "github"> =
    {
      schema: githubSendSchema,
      send: async (context, params) => {
        const fallbackTarget = parsePrFromContextId(context.contextId);
        const prNumber = params.prNumber ?? fallbackTarget?.prNumber;
        const repo =
          params.prNumber !== undefined ? params.repo : (fallbackTarget?.repo ?? params.repo);

        if (prNumber === undefined) {
          throw new ConnectorTargetRequiredError("github", "prNumber");
        }

        const encodedBody = prependContextMarker(params.body, context.contextId, "html-comment");
        this.postedComments.push({
          context,
          repo,
          prNumber,
          encodedBody,
        });

        return {
          externalId: `${repo}#${prNumber}-comment-${this.postedComments.length}`,
          summary: `Posted comment to ${repo}#${prNumber}`,
        };
      },
    };

  private readonly receiver: ConnectorReceiver<typeof githubReceiveSchema, "github"> = {
    schema: githubReceiveSchema,
    init: (ctx) => {
      this.receiverCtx = ctx;
    },
    formatInbound: (params) => ({
      title: `PR ${params.repo}#${params.prNumber}`,
      text: `[GitHub ${params.repo}#${params.prNumber}] @${params.author}:\n${params.commentBody}`,
    }),
    handleWebhook: async (req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse> => {
      const bodyText = new TextDecoder().decode(req.rawBody);
      const parsed = JSON.parse(bodyText) as z.input<typeof githubReceiveSchema> & {
        eventId?: string;
      };
      const result = await this.simulateWebhookComment(
        {
          repo: parsed.repo,
          prNumber: parsed.prNumber,
          author: parsed.author,
          commentBody: parsed.commentBody,
        },
        parsed.eventId !== undefined ? { idempotencyKey: parsed.eventId } : undefined,
      );
      return {
        status: 202,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result),
      };
    },
  };

  getSender(): ConnectorSender<typeof githubSendSchema, ConnectorSendResult, "github"> {
    return this.sender;
  }

  getReceiver(): ConnectorReceiver<typeof githubReceiveSchema, "github"> {
    return this.receiver;
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  async simulateWebhookComment(
    payload: z.input<typeof githubReceiveSchema>,
    meta?: InboundDeliveryMeta,
  ): Promise<{ readonly sessionId: string; readonly deduplicated?: boolean }> {
    if (this.receiverCtx === undefined) {
      throw new Error("MockGithubPrConnector not initialized");
    }
    const { contextId: extractedMarkerId, cleanedContent } = extractContextMarker(
      payload.commentBody,
    );
    const resolvedId = extractedMarkerId ?? `${payload.repo.toLowerCase()}#${payload.prNumber}`;
    const ctx = createConnectorContext(this, resolvedId);
    return this.receiverCtx.onReceive(ctx, { ...payload, commentBody: cleanedContent }, meta);
  }
}

export const wecomBotSendSchema = z.object({
  text: z.string().min(1),
});

export const wecomBotReceiveSchema = z.object({
  text: z.string().min(1),
});

export class MockWecomBotConnector implements Connector<
  "wecom",
  typeof wecomBotSendSchema,
  typeof wecomBotReceiveSchema
> {
  readonly name = "wecom" as const;
  readonly description = "Bidirectional WeCom bot supporting quote replies";
  stopped = false;
  readonly sentMessages: Array<{
    context: ConnectorContext<"wecom">;
    wireText: string;
  }> = [];

  private receiverCtx?: ConnectorReceiverContext<typeof wecomBotReceiveSchema, "wecom">;

  private readonly sender: ConnectorSender<
    typeof wecomBotSendSchema,
    ConnectorSendResult,
    "wecom"
  > = {
    schema: wecomBotSendSchema,
    send: async (context, params) => {
      const wireText = prependContextMarker(params.text, context.contextId, "html-comment");
      this.sentMessages.push({ context, wireText });
      return {
        externalId: `wecom-${this.sentMessages.length}`,
        summary: "Sent WeCom message",
      };
    },
  };

  private readonly receiver: ConnectorReceiver<typeof wecomBotReceiveSchema, "wecom"> = {
    schema: wecomBotReceiveSchema,
    init: (ctx) => {
      this.receiverCtx = ctx;
    },
    formatInbound: (params) => ({ text: params.text }),
    handleWebhook: async (req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse> => {
      if (this.receiverCtx === undefined) {
        throw new Error("MockWecomBotConnector not initialized");
      }
      const parsed = JSON.parse(new TextDecoder().decode(req.rawBody)) as {
        msgId?: string;
        text: string;
      };
      const { contextId, cleanedContent } = extractContextMarker(parsed.text);
      const ctx = createConnectorContext(this, contextId ?? this.receiverCtx.allocateContextId());
      const res = await this.receiverCtx.onReceive(
        ctx,
        { text: cleanedContent },
        parsed.msgId !== undefined ? { idempotencyKey: parsed.msgId } : undefined,
      );
      return {
        status: 202,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(res),
      };
    },
  };

  getSender(): ConnectorSender<typeof wecomBotSendSchema, ConnectorSendResult, "wecom"> {
    return this.sender;
  }

  getReceiver(): ConnectorReceiver<typeof wecomBotReceiveSchema, "wecom"> {
    return this.receiver;
  }

  stop(): void {
    this.stopped = true;
  }
}
