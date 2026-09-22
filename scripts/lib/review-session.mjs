/**
 * Reusable core for an agent-driven review session.
 *
 * The agent opens its own browser, loads an envelope into the app, and reads the human's
 * decisions back off the page, so the human never has to press "Copy for AI" and paste a
 * payload into the chat.
 *
 * The "I am done reviewing" gesture is the human clicking "Copy for AI" or "Download
 * feedback.dr.json". The listener that detects it is attached to the document in the
 * capture phase, never to the buttons: renderFeedback() replaces the whole feedback panel
 * on every decision, which would destroy a button-attached listener mid-review. Capture
 * phase means the flag is set before the button's own handler runs; the payload textarea
 * is already current at that point (renderFeedback writes it on every render), so reading
 * it immediately is safe.
 *
 * Local mode (`local: true`, or a port number) exists to:
 *   - pin the version under review, so a deploy mid-review cannot change the page
 *     underneath the human;
 *   - make the app same-origin, so an envelope could be handed over as a local file via
 *     `#src=/<file>.json` with no CORS and no URL length limit;
 *   - serve local UI changes without deploying, which is how a proper "Send to agent"
 *     button or comment-UX change would be iterated on safely.
 * Tradeoff: the dev server serves the working tree, which may be mid-change, so the
 * deployed URL is the safer default for ordinary use and `local` stays opt-in.
 *
 * Playwright is resolved exactly like the existing probes and is never a dependency of
 * the app itself:
 *
 *   NODE_PATH=/Users/cheng/git/md-sheet/node_modules node scripts/review-session.mjs --envelope <path>
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateFeedback } from "../../src/contract.js";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_URL = "https://element6.github.io/doc-reviewer/";
const DEFAULT_TIMEOUT_MS = 3600_000;
const HUNK_RENDER_TIMEOUT_MS = 15000;
const SERVER_START_TIMEOUT_MS = 15000;

/**
 * Errors carry a `code` so callers can map outcomes without string-matching messages:
 * "cancelled" (window closed before signalling), "timeout" (no signal within the
 * deadline), "usage"/"server"/"invalid" for everything else.
 */
export class ReviewSessionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ReviewSessionError";
    this.code = code;
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const force = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill();
  });
}

async function startLocalServer(port) {
  const child = spawn(process.execPath, [path.join(ROOT, "scripts", "dev-server.js"), String(port)], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new ReviewSessionError(`local dev server exited with code ${child.exitCode}`, "server");
      }
      try {
        if ((await fetch(`${origin}/index.html`)).ok) return { child, origin };
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new ReviewSessionError(`local dev server never came up on ${origin}`, "server");
  } catch (error) {
    await stopServer(child);
    throw error;
  }
}

/**
 * Open `url` (or a spawned local dev server), load `envelopePath` via the file input,
 * optionally hand the page to `onReady(page)`, then wait until the human clicks
 * "Copy for AI" or "Download feedback.dr.json" and return the validated payload.
 * Rejects with a ReviewSessionError whose `code` distinguishes cancelled from timed out.
 */
export async function openReviewSession({
  url = DEFAULT_URL,
  envelopePath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headless = false,
  onReady,
  local = false,
} = {}) {
  if (!envelopePath) throw new ReviewSessionError("envelopePath is required", "usage");

  const deadline = Date.now() + timeoutMs;
  let server = null;
  let browser = null;
  let page = null;
  let closeReason = null;

  try {
    if (local) {
      const port = typeof local === "number" ? local : await findFreePort();
      const started = await startLocalServer(port);
      server = started.child;
      url = started.origin;
    }

    browser = await chromium.launch({ headless });
    const context = await browser.newContext({ acceptDownloads: true });
    page = await context.newPage();

    const markClosed = (reason) => {
      closeReason ??= reason;
    };
    page.on("close", () => markClosed("review window closed"));
    browser.on("disconnected", () => markClosed("browser disconnected"));

    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Document-level capture listener: survives every feedback-panel re-render and fires
    // before the button's own handler, so the flag is visible to waitForFunction first.
    await page.evaluate(() => {
      document.addEventListener(
        "click",
        (event) => {
          const button = event.target instanceof Element ? event.target.closest("button") : null;
          if (!button) return;
          const text = (button.textContent ?? "").toLowerCase();
          if (text.includes("copy for ai") || text.includes("download")) {
            window.__reviewDone = text.includes("copy for ai") ? "copy" : "download";
          }
        },
        true,
      );
    });

    // setInputFiles instead of a `#d=` fragment: no URL length limit, any document size.
    await page.setInputFiles("#fileInput", envelopePath);
    await page.waitForSelector(".hunk", { timeout: HUNK_RENDER_TIMEOUT_MS });

    if (onReady) await onReady(page);

    try {
      await page.waitForFunction(() => Boolean(window.__reviewDone), null, {
        timeout: Math.max(1, deadline - Date.now()),
      });
    } catch (error) {
      if (closeReason !== null || page.isClosed()) {
        throw new ReviewSessionError(`${closeReason} before the review was signalled`, "cancelled");
      }
      if (error?.name === "TimeoutError" || Date.now() >= deadline) {
        throw new ReviewSessionError(`no review signal within ${timeoutMs} ms`, "timeout");
      }
      throw error;
    }

    // A textarea: inputValue() reads .value; textContent would return "".
    const raw = await page.locator('[aria-label="Feedback payload JSON"]').inputValue();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      throw new ReviewSessionError(`feedback payload is not valid JSON: ${error.message}`, "invalid");
    }
    const validation = validateFeedback(payload);
    if (!validation.ok) {
      const detail = validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join("; ");
      throw new ReviewSessionError(`feedback payload failed validation: ${detail}`, "invalid");
    }
    return payload;
  } catch (error) {
    if (error instanceof ReviewSessionError) throw error;
    if (page !== null && (closeReason !== null || page.isClosed())) {
      const reason = closeReason ?? "review window closed";
      throw new ReviewSessionError(`${reason} before the review was signalled`, "cancelled");
    }
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await stopServer(server);
  }
}
