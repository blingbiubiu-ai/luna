import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

test("dashboard app shell loads agent assets", () => {
  const html = readFileSync(join(import.meta.dir, "../index.html"), "utf-8");

  expect(html).toContain("<title>Luna</title>");
  expect(html).toContain('<div id="root"></div>');
  expect(html).toContain('href="/agent/main.css"');
  expect(html).toContain('src="/agent/main.js"');
});

test("dashboard entry keeps agent router basepath", () => {
  const source = readFileSync(join(import.meta.dir, "../src/main.tsx"), "utf-8");

  expect(source).toContain('basepath: "/agent"');
  expect(source).toContain("<RouterProvider router={router} />");
});
