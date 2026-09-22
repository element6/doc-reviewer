/**
 * Browser check for the headline path this app exists for: an AI sends a standard unified
 * diff — literally `git diff` output — and the reviewer shows it as a pretty red/green
 * change with per-hunk decisions, then hands back a valid feedback payload.
 *
 * The DOM-free suite proves the diff is APPLIED correctly (test/unified.test.js). It cannot
 * prove the app RENDERS it, which is the part the owner actually asked for. scripts/
 * smoke.mjs covers the `replace` path and the sanitizer; this covers the `unified` path.
 *
 * Runs in CI (pages.yml) and by hand locally when the proposal path changes.
 *
 *   NODE_PATH=<somewhere-with-playwright>/node_modules node scripts/unified-path-probe.mjs
 *
 * Exits non-zero if any check fails.
 */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { validateFeedback } from "../src/contract.js";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PROBE_PORT ?? 8203);
const BASE = `http://127.0.0.1:${PORT}`;
const EXAMPLE = path.join(ROOT, "examples", "unified-deploy.dr.json");

const server = spawn(process.execPath, [path.join(ROOT, "scripts", "dev-server.js"), String(PORT)], {
  cwd: ROOT,
  stdio: "ignore",
});

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
const checks = [];

function check(name, ok, detail = "") {
  checks.push(name);
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` -- ${detail}`}\n`);
}

try {
  if (!(await waitForServer())) throw new Error("dev server did not start");

  const example = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
  await page.setInputFiles("#fileInput", EXAMPLE);
  await page.waitForSelector(".hunk", { timeout: 5000 });

  check("the git-diff envelope loads with no uncaught errors", pageErrors.length === 0, pageErrors.join("; "));
  check("it renders at least one hunk", (await page.locator(".hunk").count()) > 0);

  const render = await page.evaluate(() => ({
    dels: document.querySelectorAll("del").length,
    inss: document.querySelectorAll("ins").length,
    text: document.querySelector("#docContainer")?.textContent ?? "",
  }));
  check("removed text renders as <del>", render.dels > 0, `dels=${render.dels}`);
  check("added text renders as <ins>", render.inss > 0, `inss=${render.inss}`);
  check(
    "the document reads as applied, not merely as a diff listing",
    render.text.includes("migration") || render.text.includes("runbook"),
    render.text.slice(0, 80),
  );

  await page.getByRole("button", { name: /accept all/i }).click();
  await page.waitForTimeout(200);
  const payload = JSON.parse(await page.locator('[aria-label="Feedback payload JSON"]').inputValue());
  const validation = validateFeedback(payload);

  check("the payload validates against feedback@1", validation.ok, JSON.stringify(validation.errors));
  check("the verdict is accepted", payload.verdict === "accepted", payload.verdict);
  check("the requestId round-trips", payload.requestId === example.requestId, `${payload.requestId} vs ${example.requestId}`);
  check(
    "accepting every hunk yields the diff's intended result",
    payload.result.content.includes("migration") && payload.result.content.includes("ops/runbook.md"),
    payload.result.content.slice(0, 100),
  );
  check(
    "every hunk carries a decision and its texts",
    payload.hunks.length > 0 && payload.hunks.every((hunk) => hunk.decision && typeof hunk.base === "string"),
  );

  await page.getByRole("button", { name: /reject all/i }).click();
  await page.waitForTimeout(200);
  const rejected = JSON.parse(await page.locator('[aria-label="Feedback payload JSON"]').inputValue());
  check(
    "rejecting every hunk restores the original document byte-for-byte",
    rejected.result.content === example.doc.content,
    `got ${rejected.result.content.length} chars, expected ${example.doc.content.length}`,
  );

  process.stdout.write(`\n${checks.length - failed}/${checks.length} unified-path checks passed\n`);
} catch (error) {
  process.stdout.write(`PROBE ERROR: ${error?.stack ?? error}\n`);
  failed += 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}

process.exit(failed ? 1 : 0);
