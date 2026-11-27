import { expect, test } from "bun:test";
import {
  parseLlmJson,
  sanitizeLlmJson,
  tryParseLlmJson,
  unwrapSingleCodeFence,
} from "@luna/runner-protocol/llm-json";

test("parseLlmJson handles valid JSON, BOM, and code fences", () => {
  expect(parseLlmJson('{"a":1,"b":"hello\\nworld"}')).toEqual({
    a: 1,
    b: "hello\nworld",
  });
  expect(parseLlmJson('\uFEFF{"a":1}')).toEqual({ a: 1 });
  expect(parseLlmJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  expect(unwrapSingleCodeFence('~~~json\n{"a":1}\n~~~')).toBe('{"a":1}');
  expect(unwrapSingleCodeFence("plain text")).toBeUndefined();
});

test("parseLlmJson repairs unescaped control characters, invalid escapes, and trailing commas", () => {
  const rawMultilineReply =
    '{"type":"luna.reply","version":1,"presentation":"message","replyTo":"msg-1","content":[{"type":"mention","userId":"u1"},{"type":"text","text":"第一段。\n\n第二段。\t缩进"}]}';
  expect(parseLlmJson(rawMultilineReply)).toEqual({
    type: "luna.reply",
    version: 1,
    presentation: "message",
    replyTo: "msg-1",
    content: [
      { type: "mention", userId: "u1" },
      { type: "text", text: "第一段。\n\n第二段。\t缩进" },
    ],
  });

  const fencedWithTrailingCommaAndEscapes = [
    "```json",
    "{",
    '  "quote": "don\\\'t fail",',
    '  "path": "C:\\Users\\demo",',
    '  "unicode": "\\u4e2d\\u6587",',
    '  "items": [1, 2,],',
    "}",
    "```",
  ].join("\n");
  expect(parseLlmJson(fencedWithTrailingCommaAndEscapes)).toEqual({
    quote: "don't fail",
    path: "C:\\Users\\demo",
    unicode: "中文",
    items: [1, 2],
  });
});

test("tryParseLlmJson returns undefined on plain text or unrecoverable JSON", () => {
  expect(tryParseLlmJson("")).toBeUndefined();
  expect(tryParseLlmJson("普通中文回复")).toBeUndefined();
  expect(tryParseLlmJson("{not valid json")).toBeUndefined();
  expect(sanitizeLlmJson('{"a": 1, }')).toBe('{"a": 1 }');
});
