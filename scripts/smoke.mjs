/**
 * Optional, development-only browser smoke test.
 *
 * Node can verify the whole pure pipeline, but it cannot verify the three things that
 * only exist in a real browser: the sanitizer's DOM walk, the rendered diff, and the
 * feedback payload the user actually gets. This script drives Chromium against the local
 * dev server and asserts those.
 *
 * It is NOT part of `node --test`: the app itself has zero dependencies and must stay
 * that way, while this needs Playwright. Run it when a browser is available:
 *
 *   NODE_PATH=<somewhere-with-playwright>/node_modules node scripts/smoke.mjs
 *
 * Exits non-zero on the first failed assertion.
 */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ENVELOPE_SCHEMA, validateFeedback } from "../src/contract.js";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_PORT ?? 8137);
const BASE = `http://127.0.0.1:${PORT}`;

const HOSTILE = `<h1>Hostile</h1>
<p onclick="alert(1)">Click me</p>
<script>window.__pwned = true; alert("xss");</script>
<img src="x" onerror="window.__pwned = true">
<iframe src="https://example.com"></iframe>
<a href="javascript:alert(1)">link</a>
<style>body{display:none}</style>
<p style="background:url(javascript:alert(1))">styled</p>
<blockquote cite="https://example.com/src">quoted</blockquote>`;

const checks = [];
function check(name, condition, detail = "") {
  checks.push({ name, ok: Boolean(condition), detail });
  const mark = condition ? "ok  " : "FAIL";
  process.stdout.write(`${mark} ${name}${condition || !detail ? "" : ` -- ${detail}`}\n`);
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/index.html`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

const server = spawn(process.execPath, [path.join(ROOT, "scripts", "dev-server.js"), String(PORT)], {
  cwd: ROOT,
  stdio: "ignore",
});

let browser;
let exitCode = 0;
try {
  if (!(await waitForServer())) throw new Error(`dev server never came up on ${BASE}`);

  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);

  check("the page boots with no uncaught page errors", pageErrors.length === 0, pageErrors.join("; "));
  check("no console errors on boot", consoleErrors.length === 0, consoleErrors.join("; "));
  check("the title is doc-reviewer", (await page.title()) === "doc-reviewer");

  // --- channel: file input, the default inbound path -------------------------------
  await page.setInputFiles("#fileInput", path.join(ROOT, "examples", "article.dr.json"));
  await page.waitForSelector(".hunk", { timeout: 5000 });

  const hunkCount = await page.locator(".hunk").count();
  check("an HTML envelope renders at least one hunk", hunkCount > 0, `hunks=${hunkCount}`);

  const docContainer = page.locator("#docContainer");
  check("removed text renders as <del>", (await docContainer.locator("del").count()) > 0);
  check("added text renders as <ins>", (await docContainer.locator("ins").count()) > 0);
  check(
    "a replacement is stacked in a .diff-replacement grid",
    (await docContainer.locator(".diff-replacement").count()) > 0,
  );
  check(
    "changed blocks carry a stable block id",
    (await docContainer.locator("[data-dr-block]").count()) > 0,
  );

  // Diagnostic: the document markup is what the diff renderer actually produced.
  const docHtml = await docContainer.evaluate((node) => node.innerHTML);
  process.stdout.write(`--- #docContainer markup (first 500 chars) ---\n${docHtml.slice(0, 500)}\n---\n`);

  // --- the payload the user actually hands back to the AI --------------------------
  await page.getByRole("button", { name: /accept all/i }).click();
  await page.waitForTimeout(200);

  const payloadText = await page.locator('[aria-label="Feedback payload JSON"]').inputValue();
  let payload = null;
  try {
    payload = JSON.parse(payloadText);
  } catch (error) {
    check("the feedback payload is valid JSON", false, String(error));
  }
  if (payload) {
    check("the feedback payload is valid JSON", true);
    const validation = validateFeedback(payload);
    check("the payload validates against feedback@1", validation.ok, JSON.stringify(validation.errors));
    check("the verdict is accepted after accepting every hunk", payload.verdict === "accepted", payload.verdict);
    check(
      "the result carries the accepted document text",
      typeof payload.result?.content === "string" && payload.result.content.includes("reader who is not in the room"),
      payload.result?.content?.slice(0, 60),
    );
    check(
      "every hunk is reported with a decision",
      Array.isArray(payload.hunks) && payload.hunks.every((hunk) => typeof hunk.decision === "string"),
    );
    check("the request id round-trips", payload.requestId === "example-html-1", payload.requestId);
  }

  // --- rejecting everything restores the base document -----------------------------
  await page.getByRole("button", { name: /reject all/i }).click();
  await page.waitForTimeout(200);
  const rejected = JSON.parse(await page.locator('[aria-label="Feedback payload JSON"]').inputValue());
  const baseContent = JSON.parse(
    (await import("node:fs")).readFileSync(path.join(ROOT, "examples", "article.dr.json"), "utf8"),
  ).doc.content;
  check(
    "rejecting every hunk reproduces the base document byte-for-byte",
    rejected.result.content === baseContent,
    `got ${rejected.result.content.length} chars, expected ${baseContent.length}`,
  );
  check("the verdict is rejected after rejecting every hunk", rejected.verdict === "rejected", rejected.verdict);

  // --- the comment affordance: text selection -> floating Comment -> anchor ---------
  const selectSampleText = () =>
    page.evaluate(() => {
      const root = document.getElementById("docContainer");
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = null;
      while ((node = walker.nextNode())) {
        if (node.data.length >= 60 && node.parentElement?.closest("[data-dr-block]")) break;
      }
      if (!node) return false;
      const range = document.createRange();
      range.setStart(node, 4);
      range.setEnd(node, 44);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    });

  check("sample text can be selected inside #docContainer", await selectSampleText());

  const affordance = page.locator("#selectionCommentButton");
  let affordanceShown = false;
  try {
    await affordance.waitFor({ state: "visible", timeout: 3000 });
    affordanceShown = true;
  } catch {
    affordanceShown = false;
  }
  check("selecting text surfaces the floating Comment affordance", affordanceShown);

  let textComposer = false;
  if (affordanceShown) {
    await affordance.click();
    try {
      await page.waitForSelector('[aria-label="Comment body"]', { timeout: 3000 });
      textComposer = true;
    } catch {
      textComposer = false;
    }
  }
  check("clicking the affordance opens the comment composer", textComposer);

  if (textComposer) {
    await page.locator('[aria-label="Comment body"]').fill("Text anchor probe");
    await page.getByRole("button", { name: "Add comment" }).click();
    await page.waitForTimeout(250);
  }

  const payloadAfterText = JSON.parse(await page.locator('[aria-label="Feedback payload JSON"]').inputValue());
  const textComment = (payloadAfterText.comments ?? []).find((comment) => comment.body === "Text anchor probe");
  check("the text comment lands in the feedback payload", Boolean(textComment), JSON.stringify(payloadAfterText.comments?.map((comment) => comment.body)));
  const textAnchor = textComment?.anchor;
  check(
    "the text anchor carries quote, prefix, suffix, occurrence and offset",
    Boolean(textAnchor)
      && ["quote", "prefix", "suffix", "occurrence", "offset"].every((key) => key in textAnchor)
      && typeof textAnchor.quote === "string" && textAnchor.quote.length > 0
      && typeof textAnchor.prefix === "string" && typeof textAnchor.suffix === "string"
      && Number.isInteger(textAnchor.occurrence)
      && textAnchor.offset && Number.isInteger(textAnchor.offset.start) && Number.isInteger(textAnchor.offset.end)
      && textAnchor.kind === "text",
    JSON.stringify(textAnchor ?? null),
  );
  // What the next checks do NOT prove. They pass against the unfixed 2e25888
  // sources as well: "the payload with the text comment validates" below
  // (validateFeedback over zero new comments is vacuously ok), "the affordance
  // hides once the selection is destroyed" (tautological when no affordance
  // exists), "the review-bar Comment button opens the composer for a live
  // selection" below, and "the final payload with all three comments validates"
  // (after the picker section, vacuous for the same reason). The review-bar one
  // passes because headless Chromium does NOT collapse the selection on a
  // control's mousedown — proven with a real mouse drag against unfixed sources,
  // not just programmatic selection — so no browser assertion can discriminate
  // the preventDefault half of the fix. The collapse-then-Comment stash check
  // below is the sole regression net for that root cause. The conclusion that
  // matters most: the user's reported failure is explained by the MISSING
  // AFFORDANCE (root cause 2), not by the mousedown collapse — they clicked
  // Comment with nothing selected, were told to select text, and then got no
  // affordance when they did. The affordance checks carry the regression value;
  // the preventDefault change is hardening whose effect CI cannot observe. Keep
  // the passing checks: they still assert correct behaviour, they are just not
  // regression nets.
  const textValidation = validateFeedback(payloadAfterText);
  check("the payload with the text comment validates", textValidation.ok, JSON.stringify(textValidation.errors));
  check("the affordance hides once the selection is destroyed", !(await affordance.isVisible()));

  // --- the reported bug: selection, then the review-bar Comment button --------------
  check("sample text can be re-selected", await selectSampleText());
  let barComposer = false;
  try {
    await page.locator("#reviewBar").getByRole("button", { name: "Comment" }).click();
    await page.waitForSelector('[aria-label="Comment body"]', { timeout: 3000 });
    barComposer = true;
  } catch {
    barComposer = false;
  }
  // Not a regression net: passes against unfixed sources too (headless Chromium
  // never collapses the selection on control mousedown) — see the note above.
  check("the review-bar Comment button opens the composer for a live selection", barComposer);
  if (barComposer) {
    await page.locator('[aria-label="Comment body"]').fill("Review bar probe");
    await page.getByRole("button", { name: "Add comment" }).click();
    await page.waitForTimeout(250);
  }
  const payloadAfterBar = JSON.parse(await page.locator('[aria-label="Feedback payload JSON"]').inputValue());
  check(
    "the review-bar comment lands in the feedback payload",
    (payloadAfterBar.comments ?? []).some((comment) => comment.body === "Review bar probe"),
    JSON.stringify(payloadAfterBar.comments?.map((comment) => comment.body)),
  );

  // --- the stashed range: a live selection collapsed by a control must not be lost --
  check("sample text can be selected for the stash check", await selectSampleText());
  await page.evaluate(() => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) selection.collapseToStart();
  });
  await page.waitForTimeout(100);
  let stashComposer = false;
  try {
    await page.locator("#reviewBar").getByRole("button", { name: "Comment" }).click();
    await page.waitForSelector('[aria-label="Comment body"]', { timeout: 3000 });
    stashComposer = true;
  } catch {
    stashComposer = false;
  }
  check("Comment opens the composer from the stashed range after the selection collapses", stashComposer);
  if (stashComposer) await page.getByRole("button", { name: "Cancel" }).click();

  // --- Escape dismisses the affordance but must not clear the stash ----------------
  // Escape does not collapse the selection, so the live range is collapsed below
  // before pressing c: otherwise the composer would open from the live selection
  // and the check would prove nothing about stash survival.
  check("sample text can be selected for the Escape check", await selectSampleText());
  let escapeVisible = false;
  try {
    await affordance.waitFor({ state: "visible", timeout: 3000 });
    escapeVisible = true;
  } catch {
    escapeVisible = false;
  }
  check("the affordance is visible before Escape", escapeVisible);
  await page.keyboard.press("Escape");
  check("Escape hides the affordance", escapeVisible && !(await affordance.isVisible()));
  await page.evaluate(() => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) selection.collapseToStart();
  });
  await page.waitForTimeout(100);
  let escapeStashComposer = false;
  try {
    await page.keyboard.press("c");
    await page.waitForSelector('[aria-label="Comment body"]', { timeout: 3000 });
    escapeStashComposer = true;
  } catch {
    escapeStashComposer = false;
  }
  check("pressing c after Escape still opens the composer from the stash", escapeStashComposer);
  if (escapeStashComposer) await page.getByRole("button", { name: "Cancel" }).click();

  // --- element picker: pick a block; the anchor must carry a selector ---------------
  await page.locator("#pickElementButton").click();
  let elementComposer = false;
  try {
    await page.locator("#docContainer [data-dr-block]").first().click();
    await page.waitForSelector('[aria-label="Comment body"]', { timeout: 3000 });
    elementComposer = true;
  } catch {
    elementComposer = false;
  }
  check("picking an element opens the comment composer", elementComposer);
  if (elementComposer) {
    await page.locator('[aria-label="Comment body"]').fill("Element anchor probe");
    await page.getByRole("button", { name: "Add comment" }).click();
    await page.waitForTimeout(250);
  }
  const payloadFinal = JSON.parse(await page.locator('[aria-label="Feedback payload JSON"]').inputValue());
  const elementComment = (payloadFinal.comments ?? []).find((comment) => comment.body === "Element anchor probe");
  const elementAnchor = elementComment?.anchor;
  check(
    "the element anchor carries a selector",
    Boolean(elementAnchor)
      && typeof elementAnchor.selector === "string" && elementAnchor.selector.length > 0
      && elementAnchor.kind === "element",
    JSON.stringify(elementAnchor ?? null),
  );
  // Vacuous against unfixed sources (their payload gains no new comments here);
  // see the note above "the payload with the text comment validates".
  const finalValidation = validateFeedback(payloadFinal);
  check("the final payload with all three comments validates", finalValidation.ok, JSON.stringify(finalValidation.errors));
  check(
    "the picker disarms after a pick",
    (await page.locator("#pickElementButton").getAttribute("aria-pressed")) === "false",
  );

  // --- the sanitizer's DOM walk, which node cannot exercise ------------------------
  mkdirSync(path.join(ROOT, ".tmp"), { recursive: true });
  const hostilePath = path.join(ROOT, ".tmp", "hostile.dr.json");
  writeFileSync(
    hostilePath,
    JSON.stringify({
      schema: ENVELOPE_SCHEMA,
      requestId: "hostile-1",
      doc: { id: "hostile", title: "Hostile", format: "html", revision: 1, content: HOSTILE },
      proposal: { kind: "replace", content: HOSTILE.replace("Click me", "Click me now") },
    }),
    "utf8",
  );
  await page.setInputFiles("#fileInput", hostilePath);
  await page.waitForTimeout(400);

  const injected = await page.evaluate(() => ({
    pwned: Boolean(window.__pwned),
    scripts: document.querySelectorAll("#docContainer script").length,
    iframes: document.querySelectorAll("#docContainer iframe").length,
    styles: document.querySelectorAll("#docContainer style").length,
    onHandlers: document.querySelectorAll("#docContainer [onclick], #docContainer [onerror]").length,
    jsHrefs: Array.from(document.querySelectorAll("#docContainer a")).filter((a) =>
      (a.getAttribute("href") ?? "").toLowerCase().includes("javascript:"),
    ).length,
    images: document.querySelectorAll("#docContainer img").length,
    blockquotes: document.querySelectorAll("#docContainer blockquote").length,
  }));

  check("no script from the envelope executed", injected.pwned === false);
  check("script elements are stripped", injected.scripts === 0, `found ${injected.scripts}`);
  check("iframes are stripped", injected.iframes === 0, `found ${injected.iframes}`);
  check("style elements are stripped", injected.styles === 0, `found ${injected.styles}`);
  check("event-handler attributes are stripped", injected.onHandlers === 0, `found ${injected.onHandlers}`);
  check("javascript: URLs are stripped from links", injected.jsHrefs === 0, `found ${injected.jsHrefs}`);
  check("a relative img src survives while its handler is stripped", injected.images === 1, `found ${injected.images}`);
  check("ordinary prose markup survives sanitizing", injected.blockquotes === 1, `blockquote=${injected.blockquotes}`);

  check("still no uncaught page errors after the hostile document", pageErrors.length === 0, pageErrors.join("; "));

  const failed = checks.filter((entry) => !entry.ok);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length) {
    exitCode = 1;
    process.stdout.write(`failed: ${failed.map((entry) => entry.name).join(", ")}\n`);
  }
} catch (error) {
  process.stdout.write(`SMOKE TEST ERROR: ${error?.stack ?? error}\n`);
  exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}

process.exit(exitCode);
