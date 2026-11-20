import { expect, test } from "bun:test";
import { parseReply } from "@luna/runner-protocol/reply";

test("a reply document may name the message it quotes; plain text and other documents do not", () => {
  const document = { type: "luna.reply", version: 1, presentation: "text", content: [{ type: "text", text: "好的" }] };
  expect(parseReply(JSON.stringify({ ...document, replyTo: "message-1" })).replyTo).toBe("message-1");
  expect(parseReply(JSON.stringify(document)).replyTo).toBeUndefined();
  expect(parseReply("好的").replyTo).toBeUndefined();
  expect(() => parseReply(JSON.stringify({ ...document, replyTo: "" }))).toThrow();
});
