import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  createConnectorContext,
  defineConnector,
  isBidirectionalConnector,
  isReceivableConnector,
  isSendableConnector,
  isWebhookConnector,
  type BidirectionalConnector,
  type ConnectorBase,
  type ConnectorContext,
  type ConnectorRuntimeContext,
  type ConnectorSendResult,
  type ReceiveOnlyConnector,
  type SendOnlyConnector,
} from "../src/index.js";

const notifySchema = z.object({
  channel: z.string(),
  text: z.string(),
  silent: z.boolean().default(false),
});

const alertReceiveSchema = z.object({
  alertId: z.string(),
  severity: z.enum(["info", "critical"]),
});

class TapdConnector implements BidirectionalConnector<
  typeof notifySchema,
  typeof alertReceiveSchema,
  ConnectorSendResult,
  TapdConnector
> {
  readonly name = "tapd" as const;
  readonly sendSchema = notifySchema;
  readonly receiveSchema = alertReceiveSchema;

  init(_ctx: ConnectorRuntimeContext<typeof alertReceiveSchema, TapdConnector>): void {}

  async send(
    context: ConnectorContext<TapdConnector>,
    params: z.output<typeof notifySchema>,
  ): Promise<ConnectorSendResult> {
    expectTypeOf(params.silent).toEqualTypeOf<boolean>();
    return { summary: `${context.contextId}:${params.channel}:${String(params.silent)}` };
  }
}

class GithubConnector implements ConnectorBase {
  readonly name = "github" as const;
}

describe("Capability guards and type inference", () => {
  it("narrows SendOnly, ReceiveOnly, Bidirectional, and Webhook connectors accurately", async () => {
    const sendOnly: SendOnlyConnector<typeof notifySchema> = defineConnector({
      name: "wecom-bot" as const,
      sendSchema: notifySchema,
      async send(context, params) {
        expectTypeOf(context).toMatchTypeOf<ConnectorContext>();
        expectTypeOf(params.silent).toEqualTypeOf<boolean>();
        return { externalId: `${context.connectorName}:${params.text}` };
      },
    });

    const receiveOnly: ReceiveOnlyConnector<typeof alertReceiveSchema> = defineConnector({
      name: "prometheus" as const,
      receiveSchema: alertReceiveSchema,
      init(_ctx) {},
      async handleWebhook() {
        return { status: 202 };
      },
    });

    const bidirectional = new TapdConnector();

    expect(isSendableConnector(sendOnly)).toBe(true);
    expect(isReceivableConnector(sendOnly)).toBe(false);
    expect(isBidirectionalConnector(sendOnly)).toBe(false);
    expect(isWebhookConnector(sendOnly)).toBe(false);

    expect(isSendableConnector(receiveOnly)).toBe(false);
    expect(isReceivableConnector(receiveOnly)).toBe(true);
    expect(isBidirectionalConnector(receiveOnly)).toBe(false);
    expect(isWebhookConnector(receiveOnly)).toBe(true);

    expect(isSendableConnector(bidirectional)).toBe(true);
    expect(isReceivableConnector(bidirectional)).toBe(true);
    expect(isBidirectionalConnector(bidirectional)).toBe(true);

    const ctx = createConnectorContext(sendOnly, "uuid-1");
    const res = await sendOnly.send(ctx, { channel: "ops", text: "hi", silent: true });
    expect(res.externalId).toBe("wecom-bot:hi");
  });

  it("enforces nominal-like ConnectorContext<T> isolation at compile time", () => {
    const tapd = new TapdConnector();
    const github = new GithubConnector();
    const tapdCtx = createConnectorContext(tapd, "10086");
    const githubCtx = createConnectorContext(github, "42");

    expectTypeOf(tapdCtx).toEqualTypeOf<ConnectorContext<TapdConnector>>();
    expectTypeOf(githubCtx).toEqualTypeOf<ConnectorContext<GithubConnector>>();

    // @ts-expect-error ConnectorContext<TapdConnector> must not be assignable to ConnectorContext<GithubConnector>
    const _mismatch: ConnectorContext<GithubConnector> = tapdCtx;
    void _mismatch;
  });
});
