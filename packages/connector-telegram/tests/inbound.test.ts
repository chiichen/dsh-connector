import { createConnectorContext, prependContextMarker } from "@dsh-connector/core";
import { describe, expect, it } from "vitest";
import {
  formatTelegramInboundPrompt,
  normalizeTelegramUpdate,
  parseRawTelegramUpdate,
} from "../src/inbound";
import type { TelegramUpdate } from "../src/types";

const BOT_ID = 900001;
const BOT_USERNAME = "dsh_helper_bot";

describe("Telegram inbound update parsing, routing, mention gating, and reply provenance", () => {
  it("parses valid raw Telegram Update objects and rejects malformed envelopes", () => {
    expect(parseRawTelegramUpdate(null)).toBeUndefined();
    expect(parseRawTelegramUpdate("not-json")).toBeUndefined();
    expect(parseRawTelegramUpdate({ update_id: "bad" })).toBeUndefined();

    const parsed = parseRawTelegramUpdate({
      update_id: 101,
      message: {
        message_id: 1,
        date: 1732350000,
        chat: { id: 42, type: "private", first_name: "Alice" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        text: "Hello!",
      },
    });
    expect(parsed?.update_id).toBe(101);
    expect(parsed?.message?.text).toBe("Hello!");
  });

  it("filters out bot self-messages, other bots, channel posts, automatic forwards, and empty service messages", () => {
    const baseChat = { id: -100500, type: "supergroup" as const, title: "Dev" };

    // Bot's own message (is_bot: true & matching botId)
    const selfUpdate: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1732350000,
        chat: baseChat,
        from: { id: BOT_ID, is_bot: true, first_name: "Bot", username: BOT_USERNAME },
        text: "@dsh_helper_bot echo",
      },
    };
    expect(
      normalizeTelegramUpdate(selfUpdate, { botId: BOT_ID, botUsername: BOT_USERNAME }),
    ).toBeUndefined();

    // Even if is_bot were false in a synthetic payload, matching botId or botUsername is filtered
    const spoofSelf: TelegramUpdate = {
      update_id: 2,
      message: {
        message_id: 11,
        date: 1732350000,
        chat: { id: 55, type: "private" },
        from: { id: BOT_ID, is_bot: false, first_name: "Bot" },
        text: "loop",
      },
    };
    expect(normalizeTelegramUpdate(spoofSelf, { botId: BOT_ID })).toBeUndefined();

    // Automatic forward from linked channel
    const autoForward: TelegramUpdate = {
      update_id: 3,
      message: {
        message_id: 12,
        date: 1732350000,
        chat: baseChat,
        from: { id: 77, is_bot: false, first_name: "Admin" },
        is_automatic_forward: true,
        text: `@${BOT_USERNAME} announcement`,
      },
    };
    expect(
      normalizeTelegramUpdate(autoForward, { botId: BOT_ID, botUsername: BOT_USERNAME }),
    ).toBeUndefined();

    // Channel post
    const channelPost: TelegramUpdate = {
      update_id: 4,
      channel_post: {
        message_id: 13,
        date: 1732350000,
        chat: { id: -100888, type: "channel", title: "News" },
        text: "Broadcast",
      },
    };
    expect(normalizeTelegramUpdate(channelPost, { botId: BOT_ID })).toBeUndefined();

    // Service message with no text/caption
    const serviceMsg: TelegramUpdate = {
      update_id: 5,
      message: {
        message_id: 14,
        date: 1732350000,
        chat: { id: 55, type: "private" },
        from: { id: 55, is_bot: false, first_name: "Alice" },
      },
    };
    expect(normalizeTelegramUpdate(serviceMsg, { botId: BOT_ID })).toBeUndefined();
  });

  it("routes private chats (including topic-enabled private chats) directly without requiring @mention", () => {
    const dmUpdate: TelegramUpdate = {
      update_id: 10,
      message: {
        message_id: 201,
        message_thread_id: 5,
        is_topic_message: true,
        date: 1732350100,
        chat: { id: 777888, type: "private", first_name: "Alice", last_name: "Chen" },
        from: {
          id: 777888,
          is_bot: false,
          first_name: "Alice",
          last_name: "Chen",
          username: "alice_c",
        },
        text: "Summarize today's alerts",
      },
    };

    const res = normalizeTelegramUpdate(dmUpdate, {
      botId: BOT_ID,
      botUsername: BOT_USERNAME,
    });
    expect(res).toBeDefined();
    expect(res?.contextId).toBe("p2p:777888:5");
    expect(res?.payload.text).toBe("Summarize today's alerts");
    expect(res?.meta.idempotencyKey).toBe("telegram:777888:201");
    expect(res?.meta.suggestedTitle).toBe("[Telegram] Alice Chen #5");
  });

  it("gates group/supergroup messages on @mention, UTF-16 offset entities after emoji, bot_command, text_mention, or reply_to_message to bot", () => {
    const forumChat = {
      id: -100123456,
      type: "supergroup" as const,
      title: "Platform SRE",
      is_forum: true,
    };
    const sender = { id: 321, is_bot: false, first_name: "Bob", username: "bob" };

    // Unmentioned group message is ignored in default "mention" mode
    const chatter: TelegramUpdate = {
      update_id: 20,
      message: {
        message_id: 300,
        message_thread_id: 99,
        is_topic_message: true,
        date: 1732350200,
        chat: forumChat,
        from: sender,
        text: "Anyone grabbing coffee?",
      },
    };
    expect(
      normalizeTelegramUpdate(chatter, { botId: BOT_ID, botUsername: BOT_USERNAME }),
    ).toBeUndefined();
    // Accepted in "all" mode and ignored in "off" mode
    expect(
      normalizeTelegramUpdate(chatter, {
        botId: BOT_ID,
        botUsername: BOT_USERNAME,
        groupTriggerMode: "all",
      })?.contextId,
    ).toBe("group:-100123456:99");

    // Emoji prefix ("🚀 " = 3 UTF-16 code units) before @dsh_helper_bot entity
    const prefix = "🚀 ";
    const mentionTag = `@${BOT_USERNAME}`;
    const fullText = `${prefix}${mentionTag} check pod logs`;
    const emojiMention: TelegramUpdate = {
      update_id: 21,
      message: {
        message_id: 301,
        message_thread_id: 99,
        is_topic_message: true,
        date: 1732350201,
        chat: forumChat,
        from: sender,
        text: fullText,
        entities: [{ type: "mention", offset: prefix.length, length: mentionTag.length }],
      },
    };
    const normalizedMention = normalizeTelegramUpdate(emojiMention, {
      botId: BOT_ID,
      botUsername: BOT_USERNAME,
    });
    expect(normalizedMention?.contextId).toBe("group:-100123456:99");
    expect(normalizedMention?.payload.mentionedBot).toBe(true);
    expect(normalizedMention?.payload.text).toBe("🚀 check pod logs");
    expect(
      normalizeTelegramUpdate(emojiMention, {
        botId: BOT_ID,
        botUsername: BOT_USERNAME,
        groupTriggerMode: "off",
      }),
    ).toBeUndefined();

    // /cmd@dsh_helper_bot command mention
    const cmdUpdate: TelegramUpdate = {
      update_id: 22,
      message: {
        message_id: 302,
        date: 1732350202,
        chat: forumChat,
        from: sender,
        text: `/status@${BOT_USERNAME} prod`,
        entities: [{ type: "bot_command", offset: 0, length: `/status@${BOT_USERNAME}`.length }],
      },
    };
    const normalizedCmd = normalizeTelegramUpdate(cmdUpdate, {
      botId: BOT_ID,
      botUsername: BOT_USERNAME,
    });
    expect(normalizedCmd?.payload.text).toBe("/status prod");

    // text_mention entity matching botId
    const textMentionUpdate: TelegramUpdate = {
      update_id: 23,
      message: {
        message_id: 303,
        date: 1732350203,
        chat: forumChat,
        from: sender,
        text: "Helper check alerts",
        entities: [
          {
            type: "text_mention",
            offset: 0,
            length: 6,
            user: { id: BOT_ID, is_bot: true, first_name: "Helper" },
          },
        ],
      },
    };
    expect(
      normalizeTelegramUpdate(textMentionUpdate, { botId: BOT_ID })?.payload.mentionedBot,
    ).toBe(true);

    // Reply to a bot message without @mention, including context marker in quoted bot message + TextQuote
    const botMsgWithMarker = prependContextMarker(
      "Incident INC-77 opened.",
      "incident-77",
      "bracket",
    );
    const replyUpdate: TelegramUpdate = {
      update_id: 24,
      message: {
        message_id: 304,
        message_thread_id: 99,
        date: 1732350204,
        chat: forumChat,
        from: sender,
        text: "Please assign this to oncall.",
        quote: {
          text: "Incident INC-77",
          position: 0,
        },
        reply_to_message: {
          message_id: 290,
          date: 1732350000,
          chat: forumChat,
          from: { id: BOT_ID, is_bot: true, first_name: "DSH Helper", username: BOT_USERNAME },
          text: botMsgWithMarker,
        },
      },
    };
    const normalizedReply = normalizeTelegramUpdate(replyUpdate, {
      botId: BOT_ID,
      botUsername: BOT_USERNAME,
    });
    expect(normalizedReply?.contextId).toBe("incident-77");
    expect(normalizedReply?.payload.replyToMessage).toEqual({
      messageId: 290,
      fromId: BOT_ID,
      fromUsername: BOT_USERNAME,
      fromName: "DSH Helper",
      isFromBot: true,
      text: "Incident INC-77 opened.",
      quote: "Incident INC-77",
      date: 1732350000,
    });

    // Format inbound prompt includes reply provenance
    const formatted = formatTelegramInboundPrompt(
      normalizedReply!.payload,
      createConnectorContext("telegram", normalizedReply!.contextId),
    );
    expect(formatted.title).toContain("Platform SRE");
    expect(formatted.text).toContain("Incident INC-77 opened.");
    expect(formatted.text).toContain("Incident INC-77");
    expect(formatted.text).toContain("Please assign this to oncall.");
  });

  it("enforces allowedChatIds and allowedUserIds allowlists and edited_message opt-in", () => {
    const editedUpdate: TelegramUpdate = {
      update_id: 30,
      edited_message: {
        message_id: 400,
        date: 1732350300,
        chat: { id: 500, type: "private", username: "vip_chat" },
        from: { id: 600, is_bot: false, first_name: "Carol", username: "carol" },
        caption: "Updated photo caption",
      },
    };

    expect(normalizeTelegramUpdate(editedUpdate, {})).toBeUndefined();
    expect(
      normalizeTelegramUpdate(editedUpdate, {
        acceptEditedMessages: true,
        allowedChatIds: [999],
      }),
    ).toBeUndefined();
    expect(
      normalizeTelegramUpdate(editedUpdate, {
        acceptEditedMessages: true,
        allowedChatIds: ["@vip_chat"],
        allowedUserIds: [999],
      }),
    ).toBeUndefined();
    expect(
      normalizeTelegramUpdate(editedUpdate, {
        acceptEditedMessages: true,
        allowedChatIds: ["@vip_chat"],
        allowedUserIds: ["@carol"],
      })?.payload.text,
    ).toBe("Updated photo caption");
  });
});
