import { describe, expect, test } from "bun:test";
import { StreamEventParser } from "@luna/runner-protocol/stream-parser";

describe("StreamEventParser", () => {
  test("parses a single complete event between markers", () => {
    const parser = new StreamEventParser();
    parser.feedLine('---LUNA_OUTPUT_START---');
    parser.feedLine('{"status":"stream","streamEvent":{"eventType":"text_delta","text":"hello"}}');
    const results = parser.feedLine('---LUNA_OUTPUT_END---');
    expect(results).toEqual([
      { status: "stream", data: { streamEvent: { eventType: "text_delta", text: "hello" } } },
    ]);
  });

  test("parses multiple events in sequence", () => {
    const parser = new StreamEventParser();
    const lines = [
      '---LUNA_OUTPUT_START---',
      '{"status":"stream","streamEvent":{"eventType":"text_delta","text":"a"}}',
      '---LUNA_OUTPUT_END---',
      '---LUNA_OUTPUT_START---',
      '{"status":"success","newSessionId":"sess-123"}',
      '---LUNA_OUTPUT_END---',
    ];
    const all = lines.flatMap((line) => parser.feedLine(line));
    expect(all).toHaveLength(2);
    expect(all[0]!.status).toBe("stream");
    expect(all[1]!.status).toBe("success");
  });

  test("ignores non-marker lines outside events", () => {
    const parser = new StreamEventParser();
    const results = parser.feedLine('[agent-runner] some log output');
    expect(results).toEqual([]);
  });

  test("emits protocol error on malformed JSON between markers", () => {
    const parser = new StreamEventParser();
    parser.feedLine('---LUNA_OUTPUT_START---');
    parser.feedLine('not valid json');
    const results = parser.feedLine('---LUNA_OUTPUT_END---');
    expect(results).toEqual([
      {
        status: "error",
        data: {
          error: expect.stringContaining("Malformed container protocol JSON"),
        },
      },
    ]);
  });
});
