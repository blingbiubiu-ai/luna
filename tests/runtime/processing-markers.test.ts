import { expect, test } from "bun:test";
import { completeProcessingOnce } from "../../src/messaging/processing-markers";
import { FakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";
import type { NormalizedInboundMessage } from "../../src/channels";

const inbound = { id: "message", channel: { type: "feishu", id: "channel" }, surface: { externalId: "group", kind: "group" } } as NormalizedInboundMessage;

test("reply and finalization share in-flight marker cleanup and retry a failed removal", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const channel = new FakeFeishuChannel("channel");
  channel.completeProcessing = async () => { calls++; await gate; if (calls === 1) throw new Error("provider unavailable"); };
  const reply = completeProcessingOnce(channel, inbound);
  const turn = completeProcessingOnce(channel, { ...inbound });
  expect(turn).toBe(reply);
  release();
  expect((await Promise.allSettled([reply, turn])).map(value => value.status)).toEqual(["rejected", "rejected"]);
  expect(calls).toBe(1);
  await completeProcessingOnce(channel, inbound);
  await completeProcessingOnce(channel, inbound);
  expect(calls).toBe(2);
  await completeProcessingOnce(channel, { ...inbound, id: "next-message" });
  expect(calls).toBe(3);
});
