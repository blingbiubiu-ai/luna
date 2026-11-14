import { expect, test } from "bun:test";
import { randomId } from "../src/lib/random-id";

test("Dashboard IDs work with HTTP-origin crypto without randomUUID", () => {
  const httpCrypto = { getRandomValues: crypto.getRandomValues.bind(crypto) };
  const ids = new Set(Array.from({ length: 100 }, () => randomId(httpCrypto)));
  expect(ids.size).toBe(100);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
