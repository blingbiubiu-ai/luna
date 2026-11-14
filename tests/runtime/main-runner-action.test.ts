import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { renderMainRunnerPrompt } from "../../src/main-runner/main-runner";
import type { NormalizedInboundMessage } from "../../src/channels";
import type { MainRunnerInput } from "../../src/main-runner/types";

function normalizedInbound(input: {
  readonly id: string;
  readonly text: string;
  readonly senderExternalId?: string;
  readonly surfaceExternalId?: string;
  readonly mentions?: NormalizedInboundMessage["mentions"];
  readonly addressing?: NormalizedInboundMessage["addressing"];
  readonly contentKind?: NormalizedInboundMessage["contentKind"];
  readonly presentationKind?: NormalizedInboundMessage["presentationKind"];
  readonly rawPayload?: unknown;
}): NormalizedInboundMessage {
  const senderExternalId = input.senderExternalId ?? "user-1";
  return {
    id: input.id,
    channel: { type: "feishu", id: "feishu-default" },
    surface: {
      externalId: input.surfaceExternalId ?? "group-1",
      kind: "group",
    },
    sender: {
      externalId: senderExternalId,
      kind: "user",
      providerIds: { open_id: senderExternalId },
    },
    text: input.text,
    ...(input.contentKind !== undefined ? { contentKind: input.contentKind } : {}),
    ...(input.presentationKind !== undefined
      ? { presentationKind: input.presentationKind }
      : {}),
    mentions: input.mentions ?? [],
    addressing: input.addressing ?? { addressedToBot: true, reason: "mention" },
    ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
  };
}

function mainRunnerMessageItem(input: {
  readonly messageId: string;
  readonly text: string;
  readonly senderExternalId?: string;
  readonly createdAt: number;
  readonly rawMessage?: NormalizedInboundMessage;
}) {
  const rawMessage =
    input.rawMessage ??
    normalizedInbound({
      id: input.messageId,
      text: input.text,
      ...(input.senderExternalId !== undefined
        ? { senderExternalId: input.senderExternalId }
        : {}),
    });
  return {
    messageId: input.messageId,
    channelMessageKey: rawMessage.id,
    role: "user" as const,
    senderUserId: rawMessage.sender.externalId,
    sender: {
      id: rawMessage.sender.externalId,
      externalId: rawMessage.sender.externalId,
      kind: rawMessage.sender.kind,
      displayName: rawMessage.sender.displayName ?? rawMessage.sender.externalId,
    },
    text: input.text,
    createdAt: input.createdAt,
    rawMessage,
  };
}

describe("Main Runner instruction policy", () => {
  const prompt = readFileSync(
    join(
      import.meta.dir,
      "../../src/prompts/main-runner/instructions.md",
    ),
    "utf8",
  );

  test("documents domain commands without legacy actions", () => {
    for (const command of ["luna task create", "luna task update", "luna task restart", "luna session clarify", "luna session release", "luna messages send", "LUNA_NOTHING_TO_SEND"])
      expect(prompt).toContain(command);
    for (const legacy of ["create_task_and_dispatch", "attach_existing_task_and_dispatch", "update_task_and_restart_runner", "batch_response", "reply_normal", "publish_task_result", "luna actions"])
      expect(prompt).not.toContain(legacy);
    expect(prompt).toContain("separate commands with distinct request IDs");
    expect(prompt).toContain("sourceMessageIds");
  });

  test("preserves addressing, artifact and memory boundaries", () => {
    for (const rule of ["activationSourceMessage", "strongly related", "mentions a non-Luna person or bot", "luna artifacts register <path> --json", "internal protocol details", "read-only snapshots", "$HOME/.luna-resources/memory/", "$HOME/.luna-resources/config/SOUL.md", "$HOME/.luna-resources/config/USER.md", "30-60 seconds", "blocking", "assumptions"])
      expect(prompt).toContain(rule);
    expect(prompt).toContain("status questions and unrelated messages must not restart a task");
  });

  test("renders explicit non-Luna mention signals for activation follow-ups", () => {
    const rawMessage = normalizedInbound({
      id: "channel-followup",
      text: "@Aime 个人助理 你能做什么",
      senderExternalId: "user-1",
      surfaceExternalId: "group-1",
      mentions: [
        {
          key: "@_user_1",
          label: "Aime 个人助理",
          target: {
            externalId: "ou_aime",
            kind: "bot",
            providerIds: { open_id: "ou_aime" },
          },
        },
      ],
      addressing: { addressedToBot: true, reason: "activation_followup" },
      rawPayload: {
        message: {
          content: JSON.stringify({ text: "@_user_1 你能做什么" }),
        },
      },
    });
    const input = {
      type: "user_messages",
      messages: [
        mainRunnerMessageItem({
          messageId: "message-followup",
          text: "@Aime 个人助理 你能做什么",
          createdAt: 1780919347000,
          rawMessage,
        }),
      ],
      latestMessage: rawMessage,
      activationSourceMessage: {
        messageId: "message-source",
        channelMessageKey: "channel-source",
        senderUserId: "user-1",
        createdAt: 1780919195000,
        text: "@_user_2 你好",
      },
      context: {
        sessionId: "session-1",
        candidateOpenTasks: [],
      },
    } satisfies MainRunnerInput;

    const renderedPrompt = renderMainRunnerPrompt(input);

    expect(renderedPrompt).toContain("activationFollowupAddressing");
    expect(renderedPrompt).toContain('"explicitlyAddressedByLatestMessage": false');
    expect(renderedPrompt).toContain('"latestExplicitlyMentionsNonLunaTarget": true');
    expect(renderedPrompt).toContain("Aime 个人助理");
    expect(renderedPrompt).not.toContain("@_user_1");
    expect(renderedPrompt).not.toContain("rawPayload");
    expect(renderedPrompt).not.toContain("rawMessage");
  });

  test("renders explicit current-bot mention addressee facts", () => {
    const rawMessage = normalizedInbound({
      id: "message-current-bot-mention",
      text: "@Monkey King 帮我查广州明天的天气",
      mentions: [
        {
          key: "@_user_1",
          label: "@Monkey King",
          target: {
            externalId: "ou_current_bot",
            kind: "bot",
            displayName: "Monkey King",
            providerIds: { open_id: "ou_current_bot" },
          },
        },
      ],
      addressing: { addressedToBot: true, reason: "mention" },
    });
    const input = {
      type: "user_messages",
      messages: [
        mainRunnerMessageItem({
          messageId: "message-current-bot-mention",
          text: "@Monkey King 帮我查广州明天的天气",
          createdAt: 1780919400000,
          rawMessage,
        }),
      ],
      latestMessage: rawMessage,
      context: {
        sessionId: "session-1",
        candidateOpenTasks: [],
      },
    } satisfies MainRunnerInput;

    const renderedPrompt = renderMainRunnerPrompt(input);

    expect(renderedPrompt).toContain("currentAssistantIdentity");
    expect(renderedPrompt).toContain('"explicitlyAddressedByLatestMessage": true');
    expect(renderedPrompt).toContain('"mentionLabels": [');
    expect(renderedPrompt).toContain('"@Monkey King"');
    expect(renderedPrompt).toContain(
      "These labels and display names identify the current assistant",
    );
    expect(renderedPrompt).toContain("latestMessageAddressing");
    expect(renderedPrompt).toContain('"addressedToBot": true');
    expect(renderedPrompt).toContain('"reason": "mention"');
    expect(renderedPrompt).toContain('"targetDisplayName": "Monkey King"');
    expect(renderedPrompt).not.toContain("@_user_1");
    expect(renderedPrompt).not.toContain("rawPayload");
    expect(renderedPrompt).not.toContain("rawMessage");
  });

  test("renders task restart command in the current protocol", () => {
    const rawMessage = normalizedInbound({
      id: "message-1",
      text: "刚才 did 写错了，正确的是 did=717171",
      surfaceExternalId: "chat-1",
    });
    const input = {
      type: "user_messages",
      messages: [
        mainRunnerMessageItem({
          messageId: "message-1",
          text: "刚才 did 写错了，正确的是 did=717171",
          createdAt: 1780740000000,
          rawMessage,
        }),
      ],
      latestMessage: rawMessage,
      context: {
        sessionId: "session-1",
        candidateOpenTasks: [],
      },
    } satisfies MainRunnerInput;

    const renderedPrompt = renderMainRunnerPrompt(input);
    expect(renderedPrompt).toContain("# Luna Main Runner Turn Input");
    expect(renderedPrompt).not.toContain("# Luna Main Runner Prompt");
    expect(renderedPrompt).not.toContain(
      "Do not dispatch a Task for a message that contains no actionable new information",
    );
    expect(prompt).toContain("luna task restart");
    expect(prompt).toContain("updatedTaskSummary");
    expect(prompt).toContain("updateSummary");
    expect(prompt).not.toContain('"action":');
  });

  test("does not mention removed taskRunPolicy field", () => {
    expect(prompt).not.toContain("taskRunPolicy");
  });

  test("does not mention removed stopped task model", () => {
    expect(prompt).not.toContain("stopped work");
    expect(prompt).not.toContain("stopped Task");
    expect(prompt).not.toContain("stopped task");
  });

  test("renders provider-neutral content metadata for current messages", () => {
    const rawMessage = {
      ...normalizedInbound({
        id: "message-image-1",
        text: "请看这张图\n\n![image](workspace/uploads/images/direct.jpeg)",
        contentKind: "mixed",
        presentationKind: "image_gallery",
      }),
      providerMessageType: "post",
    } satisfies NormalizedInboundMessage;
    const input = {
      type: "user_messages",
      messages: [
        mainRunnerMessageItem({
          messageId: "message-image-1",
          text: rawMessage.text,
          createdAt: 1780740000000,
          rawMessage,
        }),
      ],
      latestMessage: rawMessage,
      context: {
        sessionId: "session-1",
        candidateOpenTasks: [],
      },
    } satisfies MainRunnerInput;

    const renderedPrompt = renderMainRunnerPrompt(input);

    expect(renderedPrompt).toContain('"contentKind": "mixed"');
    expect(renderedPrompt).toContain('"presentationKind": "image_gallery"');
    expect(renderedPrompt).not.toContain("providerMessageType");
    expect(renderedPrompt).not.toContain('"post"');
    expect(renderedPrompt).toContain(
      '"text": "请看这张图\\n\\n![image](workspace/uploads/images/direct.jpeg)"',
    );
  });

  test("renders requesterUserId and activationContextMessages", () => {
    const rawMessage = normalizedInbound({
      id: "message-1",
      text: "帮忙看下上面的问题。",
      senderExternalId: "requester-1",
      surfaceExternalId: "chat-1",
    });
    const input = {
      type: "user_messages",
      requesterUserId: "requester-1",
      activationContextMessages: [
        {
          messageId: "context-message-1",
          channelMessageKey: "channel-context-message-1",
          senderUserId: "reporter-1",
          createdAt: 1780739900000,
          text: "我这边播放失败，did=123，麻烦找人看下。",
        },
        {
          messageId: "context-message-2",
          channelMessageKey: "channel-context-message-2",
          senderUserId: "helper-1",
          createdAt: 1780739950000,
          text: "@Luna 帮 reporter-1 看下这个播放失败。",
        },
      ],
      messages: [
        mainRunnerMessageItem({
          messageId: "message-1",
          text: "帮忙看下上面的问题。",
          createdAt: 1780740000000,
          rawMessage,
        }),
      ],
      latestMessage: rawMessage,
      context: {
        sessionId: "session-1",
        candidateOpenTasks: [],
      },
    } satisfies MainRunnerInput;

    const renderedPrompt = renderMainRunnerPrompt(input);
    expect(renderedPrompt).toContain('"requesterUserId": "requester-1"');
    expect(renderedPrompt).toContain('"orderedActivationContextMessages"');
    expect(renderedPrompt).toContain('"senderUserId": "reporter-1"');
    expect(renderedPrompt).toContain('"senderUserId": "helper-1"');
    expect(renderedPrompt).toContain("我这边播放失败，did=123，麻烦找人看下。");
    expect(renderedPrompt).toContain("@Luna 帮 reporter-1 看下这个播放失败。");
  });
});


test("Runner prompts and documentation do not advertise retired commands or actions", () => {
  const retired = /luna task attach|task\.attach|create\|attach\|restart|luna actions|\/api\/runner\/actions|create_task_and_dispatch|attach_existing_task_and_dispatch|update_task_and_restart_runner|ask_clarification|batch_response|no_reply|focus_shifted|publish_task_result|reply_normal|reply_status_card|task_status_reply|MainRunnerAction|action-executor|action-schema/;
  for (const root of [join(import.meta.dir, "../../src/prompts"), join(import.meta.dir, "../../docs")]) {
    for (const file of readdirSync(root, {recursive: true})) {
      if (typeof file === "string" && file.endsWith(".md")) {
        expect({file, retired: retired.test(readFileSync(join(root, file), "utf8"))}).toEqual({file, retired: false});
      }
    }
  }
});
