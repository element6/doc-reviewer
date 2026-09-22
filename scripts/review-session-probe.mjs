/**
 * Headless end-to-end check for scripts/lib/review-session.mjs.
 *
 * A human cannot be automated, so onReady() drives the review through the app's own
 * buttons — Accept all, then Copy for AI — and the session must come back with a valid
 * "accepted" payload. That proves the done-signal detection, the textarea read and the
 * validation actually work end to end without a person.
 *
 * It runs twice: once against the deployed page (the ordinary default) and once with
 * `local: true`, which spawns scripts/dev-server.js. After the local run it asserts no
 * dev-server process was left behind.
 *
 *   NODE_PATH=/Users/cheng/git/md-sheet/node_modules node scripts/review-session-probe.mjs
 *
 * Exits non-zero if any check fails.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { validateFeedback } from "../src/contract.js";
import { openReviewSession } from "./lib/review-session.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENVELOPE = path.join(ROOT, "examples", "article.dr.json");
// Phrase the proposal introduces; absent from the original doc.content, so a rejected or
// stale payload would fail the contains check.
const INTRODUCED_TEXT = "never whether it should have moved at all";

const checks = [];
function check(name, condition, detail = "") {
  checks.push({ name, ok: Boolean(condition), detail });
  const mark = condition ? "ok  " : "FAIL";
  process.stdout.write(`${mark} ${name}${condition || !detail ? "" : ` -- ${detail}`}\n`);
}

async function driveReview(page) {
  await page.getByRole("button", { name: /accept all/i }).click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: /copy for ai/i }).click();
}

// pgrep, not ps: ps is denied in this sandbox. execFileSync, not execSync, so the shell
// wrapper's own argv cannot match the pattern and pollute the pid diff. pgrep exits 1
// when nothing matches, which is the empty set, not an error.
function devServerPids() {
  try {
    const output = execFileSync("pgrep", ["-f", "dev-server.js"], { encoding: "utf8" });
    return new Set(output.split("\n").map((line) => line.trim()).filter(Boolean));
  } catch (error) {
    if (error.status === 1) return new Set();
    throw error;
  }
}

async function runScenario(label, options) {
  let payload = null;
  let failure = null;
  try {
    payload = await openReviewSession({
      envelopePath: ENVELOPE,
      headless: true,
      ...options,
      onReady: driveReview,
    });
  } catch (error) {
    failure = error;
  }
  check(`${label}: session resolved a payload`, payload !== null, failure ? String(failure?.message ?? failure) : "");
  if (!payload) return;

  const validation = validateFeedback(payload);
  check(
    `${label}: validateFeedback passes`,
    validation.ok,
    validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join("; "),
  );
  check(`${label}: verdict is accepted`, payload.verdict === "accepted", `verdict=${payload.verdict}`);
  const decisions = Array.isArray(payload.hunks) ? payload.hunks.map((hunk) => hunk.decision) : [];
  check(
    `${label}: every hunk has a decision`,
    decisions.length > 0 && decisions.every((decision) => decision && decision !== "unresolved"),
    JSON.stringify(decisions),
  );
  check(
    `${label}: result.content contains the accepted text`,
    typeof payload.result?.content === "string" && payload.result.content.includes(INTRODUCED_TEXT),
  );
}

let exitCode = 0;
try {
  const pidsBefore = devServerPids();
  await runScenario("deployed", {});
  await runScenario("local", { local: true });
  const leftovers = [...devServerPids()].filter((pid) => !pidsBefore.has(pid));
  check("local run left no dev-server process behind", leftovers.length === 0, `pids: ${leftovers.join(", ")}`);
} catch (error) {
  process.stdout.write(`REVIEW SESSION PROBE ERROR: ${error?.stack ?? error}\n`);
  exitCode = 1;
}

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
if (failed.length) {
  process.stdout.write(`failed: ${failed.map((entry) => entry.name).join(", ")}\n`);
  exitCode = 1;
}
process.exitCode = exitCode;
setTimeout(() => process.exit(exitCode), 2000).unref();
