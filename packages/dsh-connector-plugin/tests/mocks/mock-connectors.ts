import { z } from "zod";
import {
  ConnectorTargetRequiredError,
  extractContextMarker,
  prependContextMarker,
  type BidirectionalConnector,
  type ConnectorContext,
  type ConnectorRuntimeContext,
  type ConnectorSendResult,
  type ConnectorWebhookRequest,
  type ConnectorWebhookResponse,
  type InboundDeliveryMeta,
  type ReceiveOnlyConnector,
  type SendOnlyConnector,
} from "@dsh-connector/core";

export const wecomSendSchema = z.object({
  webhookKey: z.string().min(1),
  text: z.string().min(1),
});

export class MockWecomNotifyConnector implements SendOnlyConnector<
  typeof wecomSendSchema,
  ConnectorSendResult,
  MockWecomNotifyConnector
> {
  readonly name = "wecom" as const;
  readonly description = "Send notification to WeCom group bot";
  readonly sendSchema = wecomSendSchema;
  readonly sentCalls: Array<{
    context: ConnectorContext<MockWecomNotifyConnector>;
    params: z.output<typeof wecomSendSchema>;
  }> = [];

  async send(
    context: ConnectorContext<MockWecomNotifyConnector>,
    params: z.output<typeof wecomSendSchema>,
  ): Promise<ConnectorSendResult> {
    const encodedText = prependContextMarker(params.text, context.contextId, "bracket");
    this.sentCalls.push({ context, params: { ...params, text: encodedText } });
    return {
      externalId: `wecom-msg-${this.sentCalls.length}`,
      summary: `Sent to ${params.webhookKey}`,
    };
  }
}

export const alertReceiveSchema = z.object({
  severity: z.enum(["warning", "critical"]),
  message: z.string(),
  fingerprint: z.string().optional(),
});

export class MockAlertIngestConnector implements ReceiveOnlyConnector<
  typeof alertReceiveSchema,
  MockAlertIngestConnector
> {
  readonly name = "alertmanager" as const;
  readonly receiveSchema = alertReceiveSchema;
  private runtimeCtx?: ConnectorRuntimeContext<typeof alertReceiveSchema, MockAlertIngestConnector>;

  init(ctx: ConnectorRuntimeContext<typeof alertReceiveSchema, MockAlertIngestConnector>): void {
    this.runtimeCtx = ctx;
  }

  async simulateAlert(
    payload: z.input<typeof alertReceiveSchema>,
    meta?: InboundDeliveryMeta,
  ): Promise<{ readonly sessionId: string; readonly deduplicated?: boolean }> {
    if (this.runtimeCtx?.onReceive === undefined) {
      throw new Error("MockAlertIngestConnector not initialized");
    }
    const ctx =
      payload.fingerprint !== undefined
        ? this.runtimeCtx.createContext(`fp:${payload.fingerprint}`)
        : this.runtimeCtx.createContext();
    return this.runtimeCtx.onReceive(ctx, payload, meta);
  }

  async handleWebhook(req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse> {
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

export class MockGithubPrConnector implements BidirectionalConnector<
  typeof githubSendSchema,
  typeof githubReceiveSchema,
  ConnectorSendResult,
  MockGithubPrConnector
> {
  readonly name = "github" as const;
  readonly description = "Comment on GitHub pull requests and receive review comments";
  readonly sendSchema = githubSendSchema;
  readonly receiveSchema = githubReceiveSchema;

  started = false;
  stopped = false;
  readonly postedComments: Array<{
    context: ConnectorContext<MockGithubPrConnector>;
    repo: string;
    prNumber: number;
    encodedBody: string;
  }> = [];

  private runtimeCtx?: ConnectorRuntimeContext<typeof githubReceiveSchema, MockGithubPrConnector>;

  init(ctx: ConnectorRuntimeContext<typeof githubReceiveSchema, MockGithubPrConnector>): void {
    this.runtimeCtx = ctx;
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  formatInbound(
    params: z.output<typeof githubReceiveSchema>,
    _context: ConnectorContext<MockGithubPrConnector>,
  ) {
    return {
      title: `PR ${params.repo}#${params.prNumber}`,
      text: `[GitHub ${params.repo}#${params.prNumber}] @${params.author}:\n${params.commentBody}`,
    };
  }

  async simulateWebhookComment(
    payload: z.input<typeof githubReceiveSchema>,
    meta?: InboundDeliveryMeta,
  ): Promise<{ readonly sessionId: string; readonly deduplicated?: boolean }> {
    if (this.runtimeCtx?.onReceive === undefined) {
      throw new Error("MockGithubPrConnector not initialized");
    }
    const { contextId: extractedMarkerId, cleanedContent } = extractContextMarker(
      payload.commentBody,
    );
    const resolvedId = extractedMarkerId ?? `${payload.repo.toLowerCase()}#${payload.prNumber}`;
    const ctx = this.runtimeCtx.createContext(resolvedId);
    return this.runtimeCtx.onReceive(ctx, { ...payload, commentBody: cleanedContent }, meta);
  }

  async send(
    context: ConnectorContext<MockGithubPrConnector>,
    params: z.output<typeof githubSendSchema>,
  ): Promise<ConnectorSendResult> {
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
  }
}
