/**
 * Agent-facing CLI for a review session.
 *
 *   node scripts/review-session.mjs --envelope <path> [--url <url>] [--timeout <seconds>]
 *                                    [--headless] [--local] [--port <n>]
 *
 * stdout carries ONLY the pretty-printed JSON payload, so it can be piped straight into a
 * file or a parser. Every hint, diagnostic and error goes to stderr. Exit codes: 0 payload
 * printed; 2 window closed without signalling; 3 timed out; 1 any other error.
 *
 * --local spawns scripts/dev-server.js and reviews against the working tree instead of the
 * deployed page; see scripts/lib/review-session.mjs for why local mode exists and when the
 * deployed default is safer. REVIEW_HEADLESS=1 is equivalent to --headless.
 *
 *   NODE_PATH=/Users/cheng/git/md-sheet/node_modules node scripts/review-session.mjs --envelope examples/article.dr.json
 */

import fs from "node:fs";
import path from "node:path";

import { DEFAULT_URL, openReviewSession } from "./lib/review-session.mjs";

const USAGE = `usage: node scripts/review-session.mjs --envelope <path> [--url <url>] [--timeout <seconds>]
                                      [--headless] [--local] [--port <n>]

  --envelope <path>  envelope JSON to review (required)
  --url <url>        page to open (default ${DEFAULT_URL})
  --timeout <sec>    give up after this many seconds (default 3600)
  --headless         run without a visible window (or REVIEW_HEADLESS=1)
  --local            serve the working tree via scripts/dev-server.js instead of deploying
  --port <n>         local mode: dev-server port, a free port if omitted (implies --local)
  --help             print this help

exit codes: 0 payload printed, 2 window closed without signalling, 3 timed out, 1 error`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const options = {
  envelope: undefined,
  url: DEFAULT_URL,
  timeoutSeconds: 3600,
  headless: ["1", "true"].includes(process.env.REVIEW_HEADLESS ?? ""),
  local: false,
  port: undefined,
};

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const next = () => {
    index += 1;
    if (index >= args.length) fail(`${arg} requires a value`);
    return args[index];
  };
  if (arg === "--envelope") options.envelope = next();
  else if (arg === "--url") options.url = next();
  else if (arg === "--timeout") {
    const seconds = Number(next());
    if (!Number.isFinite(seconds) || seconds <= 0) fail("--timeout must be a positive number of seconds");
    options.timeoutSeconds = seconds;
  } else if (arg === "--headless") options.headless = true;
  else if (arg === "--local") options.local = true;
  else if (arg === "--port") {
    const port = Number(next());
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port must be an integer 1-65535");
    options.port = port;
    options.local = true;
  } else if (arg === "--help" || arg === "-h") {
    process.stderr.write(`${USAGE}\n`);
    process.exit(0);
  } else {
    fail(`unknown argument: ${arg}\n${USAGE}`);
  }
}

if (!options.envelope) fail(`--envelope is required\n${USAGE}`);
const envelopePath = path.resolve(options.envelope);
if (!fs.existsSync(envelopePath)) fail(`envelope not found: ${envelopePath}`);

try {
  const payload = await openReviewSession({
    url: options.url,
    envelopePath,
    timeoutMs: options.timeoutSeconds * 1000,
    headless: options.headless,
    local: options.local ? (options.port ?? true) : false,
    onReady: async (page) => {
      process.stderr.write(
        `Review window open at ${page.url()}. Decide the hunks, then press "Copy for AI" — ` +
          `your decisions are read automatically. Close the window to cancel.\n`,
      );
    },
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} catch (error) {
  if (error?.code === "cancelled") {
    process.stderr.write("Review window closed without a signal; no payload.\n");
    process.exitCode = 2;
  } else if (error?.code === "timeout") {
    process.stderr.write(`Timed out after ${options.timeoutSeconds}s waiting for the review signal.\n`);
    process.exitCode = 3;
  } else {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}

// Never let a stray handle hang the CLI once the outcome is decided; unref so a clean
// event loop still exits on its own with the same code.
setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
