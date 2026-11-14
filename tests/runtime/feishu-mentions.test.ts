import { describe, expect, test } from "bun:test";

import {
  formatFeishuAtTag,
  mapFeishuMentions,
  renderFeishuMentionText,
  resolveFeishuAddressing,
  textStartsWithConfiguredAlias,
  wrapContentWithFeishuMentions,
} from "../../extensions/channels/feishu/messaging/mentions";
import {
  renderFeishuMentions,
  toMentionLabel,
} from "../../extensions/channels/feishu/messaging/feishu-mention-renderer";
import { createFeishuNormalizer } from "../../extensions/channels/feishu/messaging/feishu-normalizer";

describe("Feishu mention helpers", () => {
  test("normalizes Feishu mention tokens into rendered text", async () => {
    const normalizer = createFeishuNormalizer({
      identityScope: {environment: "feishu", appId: "test-app"},
      channel: { type: "feishu", id: "main" },
      botIdentity: {
        externalId: "ou_bot",
        kind: "bot",
        displayName: "Luna",
        providerIds: { open_id: "ou_bot" },
      },
    });

    const message = await normalizer.normalizeMessageEvent({
      message_id: "om_1",
      chat_id: "oc_group",
      chat_type: "group",
      sender: {
        sender_id: { open_id: "ou_user", user_id: "u_user" },
        sender_type: "user",
      },
      content: JSON.stringify({ text: "@_user_1 在吗" }),
      mentions: [
        {
          key: "@_user_1",
          name: "Luna",
          id: { open_id: "ou_bot", user_id: "u_bot" },
          tenant_key: "tenant_1",
        },
      ],
    });

    expect(message.text).toBe("@Luna 在吗");
    expect(message.text).not.toContain("@_user_1");
    expect(message.mentions[0]).toEqual(
      expect.objectContaining({
        key: "@_user_1",
        label: "@Luna",
        target: expect.objectContaining({ externalId: "ou_bot", kind: "bot" }),
      }),
    );
    expect(message.addressing).toEqual({
      addressedToBot: true,
      reason: "mention",
    });
  });

  test("rejects malformed Feishu text content", () => {
    const normalizer = createFeishuNormalizer({
      identityScope: {environment: "feishu", appId: "test-app"},
      channel: { type: "feishu", id: "main" },
    });

    expect(() =>
      normalizer.normalizeMessageEvent({
        message_id: "om_bad_json",
        chat_id: "oc_group",
        chat_type: "group",
        sender: {
          sender_id: { open_id: "ou_user" },
          sender_type: "user",
        },
        content: "{",
      }),
    ).toThrow(/om_bad_json.*invalid Feishu text content/);
  });

  test("rejects Feishu text content without a string text field", () => {
    const normalizer = createFeishuNormalizer({
      identityScope: {environment: "feishu", appId: "test-app"},
      channel: { type: "feishu", id: "main" },
    });

    expect(() =>
      normalizer.normalizeMessageEvent({
        message_id: "om_missing_text",
        chat_id: "oc_group",
        chat_type: "group",
        sender: {
          sender_id: { open_id: "ou_user" },
          sender_type: "user",
        },
        content: JSON.stringify({ title: "hello" }),
      }),
    ).toThrow(/om_missing_text.*invalid Feishu text content/);

    expect(() =>
      normalizer.normalizeMessageEvent({
        message_id: "om_non_string_text",
        chat_id: "oc_group",
        chat_type: "group",
        sender: {
          sender_id: { open_id: "ou_user" },
          sender_type: "user",
        },
        content: JSON.stringify({ text: 123 }),
      }),
    ).toThrow(/om_non_string_text.*invalid Feishu text content/);
  });

  test("preserves legal empty Feishu text content", () => {
    const normalizer = createFeishuNormalizer({
      identityScope: {environment: "feishu", appId: "test-app"},
      channel: { type: "feishu", id: "main" },
    });

    expect(
      normalizer.normalizeMessageEvent({
        message_id: "om_empty_text",
        chat_id: "oc_group",
        chat_type: "group",
        sender: {
          sender_id: { open_id: "ou_user" },
          sender_type: "user",
        },
        content: JSON.stringify({ text: "" }),
      }).text,
    ).toBe("");
  });

  test("rejects Feishu sender without a stable id", () => {
    const normalizer = createFeishuNormalizer({
      identityScope: {environment: "feishu", appId: "test-app"},
      channel: { type: "feishu", id: "main" },
    });

    expect(() =>
      normalizer.normalizeMessageEvent({
        message_id: "om_missing_sender",
        chat_id: "oc_group",
        chat_type: "group",
        sender: {
          sender_id: {},
          sender_type: "user",
        },
        content: JSON.stringify({ text: "hello" }),
      }),
    ).toThrow(/om_missing_sender.*Feishu sender is missing stable id/);
  });

  test("renders provider mention keys in a single pass", () => {
    const mentions = [
      {
        key: "@_user_1",
        label: "@Luna",
        target: { externalId: "ou_bot", kind: "bot" as const },
      },
      {
        key: "@_user_10",
        label: "@_user_1",
        target: { externalId: "ou_reporter", kind: "user" as const },
      },
    ];

    expect(
      renderFeishuMentions("@_user_10 和 @_user_1 在吗", mentions),
    ).toBe("@_user_1 和 @Luna 在吗");
    expect(
      renderFeishuMentions("@_user_10 和 @_user_1 在吗", mentions),
    ).not.toBe("@Luna 和 @Luna 在吗");
  });

  test("formats mention labels with stable fallback", () => {
    expect(toMentionLabel("Luna", "ou_bot")).toBe("@Luna");
    expect(toMentionLabel("@Luna", "ou_bot")).toBe("@Luna");
    expect(toMentionLabel(" ", "ou_bot")).toBe("@ou_bot");
  });

  test("maps Feishu mentions to inbound mention metadata", () => {
    const mentions = mapFeishuMentions([
      {
        key: "@_user_1",
        name: "Luna Bot",
        id: { open_id: "ou_bot", user_id: "bot_user", union_id: "on_bot" },
        mentioned_type: "bot",
      },
    ]);

    expect(mentions).toEqual([
      {
        key: "@_user_1",
        name: "Luna Bot",
        openId: "ou_bot",
        userId: "bot_user",
        unionId: "on_bot",
        mentionedType: "bot",
      },
    ]);
  });

  test("matches explicit bot mention by stable identity", () => {
    const mentions = mapFeishuMentions([
      { key: "@_bot", name: "Any Display Name", id: { open_id: "ou_bot" } },
    ]);

    expect(
      resolveFeishuAddressing({
        chatType: "group",
        text: "@Luna 处理一下",
        mentions,
        botIdentity: { openId: "ou_bot" },
        groupBotAliases: [],
      }),
    ).toEqual({ addressedToBot: true, reason: "mention" });
  });

  test("renders Feishu mention placeholders into semantic display text", () => {
    const mentions = mapFeishuMentions([
      {
        key: "@_user_1",
        name: "Luna Bot",
        id: { open_id: "ou_bot" },
        mentioned_type: "bot",
      },
      {
        key: "@_user_2",
        name: "Alice",
        id: { open_id: "ou_alice" },
        mentioned_type: "user",
      },
    ]);

    expect(
      renderFeishuMentionText({
        text: "@_user_1 帮我查广州明天的天气",
        mentions,
      }),
    ).toEqual({
      text: "@Luna Bot 帮我查广州明天的天气",
      renderedMentionKeys: ["@_user_1"],
    });
    expect(
      renderFeishuMentionText({
        text: "@_user_2 看一下 @_user_1",
        mentions,
      }).text,
    ).toBe("@Alice 看一下 @Luna Bot");
  });

  test("does not activate by display name when identity and alias are absent", () => {
    const mentions = mapFeishuMentions([
      { key: "@_bot", name: "Luna", id: { open_id: "ou_unknown" } },
    ]);

    expect(
      resolveFeishuAddressing({
        chatType: "group",
        text: "@Luna 处理一下",
        mentions,
        botIdentity: { openId: "ou_bot" },
        groupBotAliases: [],
      }),
    ).toEqual({ addressedToBot: false, reason: "silent_group" });
  });

  test("activates configured aliases only as leading call phrases", () => {
    expect(textStartsWithConfiguredAlias("小助手 看下广州天气", ["小助手"])).toBe(true);
    expect(textStartsWithConfiguredAlias("请小助手看下广州天气", ["小助手"])).toBe(false);
  });

  test("formats Feishu at tags from sender ids", () => {
    expect(formatFeishuAtTag("ou_requester")).toBe('<at user_id="ou_requester"></at>');
  });

  test("wraps addressed group content with requester prefix and reporter cc", () => {
    expect(
      wrapContentWithFeishuMentions("处理结果", {
        requesterUserId: "user-b",
        ccSenderUserIds: ["user-a", "user-c"],
      }),
    ).toBe(
      '<at user_id="user-b"></at> 处理结果\n\ncc <at user_id="user-a"></at> <at user_id="user-c"></at>',
    );
  });

  test("sanitizes raw model-authored Feishu at tags before rendering", () => {
    const wrapped = wrapContentWithFeishuMentions(
      '<at user_id="user-z"></at> hi',
      undefined,
    );

    expect(wrapped).not.toContain('<at user_id="user-z"></at>');
    expect(wrapped).toContain('&lt;at user_id=&quot;user-z&quot;&gt;&lt;/at&gt; hi');
  });

  test("sanitizes raw tags while preserving structured requester and cc tags", () => {
    const wrapped = wrapContentWithFeishuMentions(
      '<at user_id="user-z"></at> hi',
      {
        requesterUserId: "user-b",
        ccSenderUserIds: ["user-a"],
      },
    );

    expect(wrapped).toStartWith('<at user_id="user-b"></at> ');
    expect(wrapped).toContain('\n\ncc <at user_id="user-a"></at>');
    expect(wrapped).not.toContain('<at user_id="user-z"></at>');
    expect(wrapped).toContain('&lt;at user_id=&quot;user-z&quot;&gt;&lt;/at&gt; hi');
  });

  test("does not mutate p2p content when mention metadata is absent", () => {
    expect(wrapContentWithFeishuMentions("处理结果", undefined)).toBe("处理结果");
  });
});
