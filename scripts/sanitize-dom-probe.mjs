/**
 * DOM probe for the sanitizer's real DOM walk — development only.
 *
 * `node --test` cannot cover `sanitizeHtml`: it needs a document, and the app ships with
 * zero dependencies, so no DOM implementation is available under node. This script boots
 * the local dev server, imports the real module in a real browser, and runs the hostile
 * vectors that the independent verification pass identified. Two of them were real
 * bypasses that the 94-test suite could not see.
 *
 * It is NOT part of `node --test` and NOT a CI gate; run it by hand when the sanitizer
 * changes:
 *
 *   NODE_PATH=<somewhere-with-playwright>/node_modules node scripts/sanitize-dom-probe.mjs
 *
 * Exits non-zero if any vector regresses.
 */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const PORT = Number(process.env.PROBE_PORT ?? 8199);
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ["scripts/dev-server.js", String(PORT)], { stdio: "ignore" });

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/index.html`)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

let browser;
let failed = 0;
try {
  if (!(await waitForServer())) throw new Error("dev server did not start");

  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });

  const observed = await page.evaluate(async () => {
    const { sanitizeHtml } = await import("/src/sanitize.js");
    const vectors = {
      // Unwrap must not launder a promoted descendant past the removal pass. scrub() used
      // to iterate a snapshot taken before unwrap promoted these children.
      "promoted <style>": '<svg><style>@import url(https://evil.example/x);</style></svg>',
      "promoted <meta refresh>": '<svg><meta http-equiv="refresh" content="0;url=https://evil.example"></svg>',
      "promoted <iframe>": '<foo><iframe src="https://evil.example"></iframe></foo>',
      "promoted <script>": "<math><script>window.__pwned=1<\\/script></math>",
      // A CSS escape decodes to the blocked token, so it must be refused.
      "escaped url(": '<p style="background-image:\\75 rl(https://evil.example/x)">x</p>',
      "escaped expression(": '<p style="color:\\65 xpression(alert(1))">x</p>',
      // A parsed <template>'s children live in .content, so unwrapping drops the text.
      "template text": "<template><p>hidden text</p></template>",
      // The parser decodes the entity, so the scheme check must see the real value.
      "entity colon": '<a href="javascript&colon;alert(1)">e</a>',
      // Controls: ordinary prose and legitimate safe styling must survive.
      "control prose": '<blockquote cite="https://example.com/src">quoted</blockquote>',
      "control safe style": '<p style="color:red;text-align:center">ok</p>',
    };
    const out = {};
    for (const [name, html] of Object.entries(vectors)) {
      try {
        out[name] = sanitizeHtml(html);
      } catch (error) {
        out[name] = `THREW: ${error.message}`;
      }
    }
    return out;
  });

  const expectations = [
    ["promoted <style>", (s) => !/<style/i.test(s) && !/@import/i.test(s)],
    ["promoted <meta refresh>", (s) => !/<meta/i.test(s)],
    ["promoted <iframe>", (s) => !/<iframe/i.test(s)],
    ["promoted <script>", (s) => !/<script/i.test(s)],
    ["escaped url(", (s) => !/\\/.test(s) || !/style=/i.test(s)],
    ["escaped expression(", (s) => !/\\/.test(s) || !/style=/i.test(s)],
    ["template text", (s) => !/<template/i.test(s)],
    ["entity colon", (s) => !/javascript:/i.test(s)],
    ["control prose", (s) => /quoted/.test(s)],
    ["control safe style", (s) => /color:\s*red/i.test(s)],
  ];

  for (const [name, predicate] of expectations) {
    const value = observed[name];
    const ok = predicate(value);
    if (!ok) failed += 1;
    process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}  ->  ${JSON.stringify(value)}\n`);
  }
  process.stdout.write(`\n${expectations.length - failed}/${expectations.length} probe checks passed\n`);
} catch (error) {
  process.stdout.write(`PROBE ERROR: ${error?.stack ?? error}\n`);
  failed += 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}

process.exit(failed ? 1 : 0);
