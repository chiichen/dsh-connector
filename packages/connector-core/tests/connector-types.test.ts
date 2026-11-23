import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  createConnectorContext,
  defineConnector,
  type Connector,
  type ConnectorContext,
  type ConnectorReceiver,
  type ConnectorReceiverContext,
  type ConnectorSender,
  type ConnectorSendResult,
} from "../src";

const notifySchema = z.object({
  channel: z.string(),
  text: z.string(),
  silent: z.boolean().default(false),
});

const alertReceiveSchema = z.object({
  alertId: z.string(),
  severity: z.enum(["info", "critical"]),
});

class TapdConnector implements Connector<"tapd", typeof notifySchema, typeof alertReceiveSchema> {
  readonly name = "tapd" as const;

  private readonly sender: ConnectorSender<typeof notifySchema, ConnectorSendResult, "tapd"> = {
    description: "Send TAPD story update",
    schema: notifySchema,
    async send(context, params) {
      expectTypeOf(context).toEqualTypeOf<ConnectorContext<"tapd">>();
      expectTypeOf(params.silent).toEqualTypeOf<boolean>();
      return { summary: `${context.contextId}:${params.channel}:${String(params.silent)}` };
    },
  };

  private readonly receiver: ConnectorReceiver<typeof alertReceiveSchema, "tapd"> = {
    schema: alertReceiveSchema,
    init(_ctx: ConnectorReceiverContext<typeof alertReceiveSchema, "tapd">): void {},
    formatInbound(params, context) {
      expectTypeOf(context).toEqualTypeOf<ConnectorContext<"tapd">>();
      return `[${params.severity}] ${params.alertId}`;
    },
  };

  getSender(): ConnectorSender<typeof notifySchema, ConnectorSendResult, "tapd"> {
    return this.sender;
  }

  getReceiver(): ConnectorReceiver<typeof alertReceiveSchema, "tapd"> {
    return this.receiver;
  }
}

describe("Connector, ConnectorSender, and ConnectorReceiver contracts", () => {
  it("models send-only, receive-only, and bidirectional connectors via getSender() and getReceiver() without any types", async () => {
    const sendOnly = defineConnector({
      name: "wecom-bot",
      getSender: () => ({
        schema: notifySchema,
        async send(context, params) {
          expectTypeOf(context).toEqualTypeOf<ConnectorContext<"wecom-bot">>();
          expectTypeOf(params.silent).toEqualTypeOf<boolean>();
          return { externalId: `${context.connectorName}:${params.text}` };
        },
      }),
      getReceiver: () => undefined,
    });

    const receiveOnly = defineConnector({
      name: "prometheus",
      getSender: () => undefined,
      getReceiver: () => ({
        schema: alertReceiveSchema,
        init(_ctx) {},
        async handleWebhook() {
          return { status: 202 };
        },
      }),
    });

    const bidirectional = new TapdConnector();

    expect(sendOnly.getSender()).toBeDefined();
    expect(sendOnly.getReceiver()).toBeUndefined();

    expect(receiveOnly.getSender()).toBeUndefined();
    expect(receiveOnly.getReceiver()).toBeDefined();
    expect(receiveOnly.getReceiver()?.handleWebhook).toBeTypeOf("function");

    expect(bidirectional.getSender()).toBeDefined();
    expect(bidirectional.getReceiver()).toBeDefined();

    const heterogeneousList: readonly Connector[] = [sendOnly, receiveOnly, bidirectional];
    expect(heterogeneousList).toHaveLength(3);

    const ctx = createConnectorContext(sendOnly, "uuid-1");
    const res = await sendOnly.getSender()!.send(ctx, {
      channel: "ops",
      text: "hi",
      silent: true,
    });
    expect(res.externalId).toBe("wecom-bot:hi");
  });

  it("supports general z.ZodType schemas on ConnectorSender (such as z.discriminatedUnion or refined schemas)", async () => {
    const unionSendSchema = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("dm"), userId: z.string(), text: z.string() }),
      z.object({ kind: z.literal("room"), roomId: z.string(), text: z.string() }),
    ]);

    const imConnector = defineConnector({
      name: "im-gateway",
      getSender: () => ({
        schema: unionSendSchema,
        async send(_ctx, params) {
          return {
            summary: params.kind === "dm" ? `dm:${params.userId}` : `room:${params.roomId}`,
          };
        },
      }),
      getReceiver: () => undefined,
    });

    const list: readonly Connector[] = [imConnector];
    expect(list).toHaveLength(1);

    const ctx = createConnectorContext(imConnector, "conv-1");
    const sent = await imConnector
      .getSender()!
      .send(ctx, { kind: "dm", userId: "u-1", text: "ping" });
    expect(sent.summary).toBe("dm:u-1");
  });

  it("enforces nominal-like ConnectorContext<TName> isolation at compile time", () => {
    const tapd = new TapdConnector();
    const tapdCtx = createConnectorContext(tapd, "10086");
    const githubCtx = createConnectorContext("github", "42");

    expectTypeOf(tapdCtx).toEqualTypeOf<ConnectorContext<"tapd">>();
    expectTypeOf(githubCtx).toEqualTypeOf<ConnectorContext<"github">>();

    // @ts-expect-error ConnectorContext<"tapd"> must not be assignable to ConnectorContext<"github">
    const _mismatch: ConnectorContext<"github"> = tapdCtx;
    void _mismatch;

    if (false as boolean) {
      // @ts-expect-error githubCtx must be rejected by tapd sender
      void tapd.getSender().send(githubCtx, { channel: "ops", text: "hi", silent: false });
      // @ts-expect-error invalid payload fields must be rejected by tapd sender
      void tapd.getSender().send(tapdCtx, { channel: 123 });
    }
  });
});
