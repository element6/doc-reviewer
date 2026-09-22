/**
 * Diff-engine tests for src/unified.js.
 *
 * Fixtures marked "captured" are byte-for-byte output of
 * `git diff --no-index old.md new.md` (git 2.54.0), generated in /tmp; blank context
 * lines carry their single leading space (built as quoted " " entries so that space
 * cannot go missing in editing). The engine is strict — a hunk applies at the line its
 * header declares or is reported — so every applied result is asserted byte-for-byte
 * against the intended new document.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { applyUnifiedDiff, parseUnifiedDiff } from "../src/unified.js";

// Captured: git diff --no-index deploy-old.md deploy-new.md
const DEPLOY_BASE =
  "Deploy checklist\n\n1. Run the test suite.\n2. Tag the release.\n3. Announce in the channel.\n\nRollback is documented in the runbook.\n";
const DEPLOY_NEW =
  "Deploy checklist\n\n1. Run the test suite.\n2. Run the migration.\n3. Tag the release.\n4. Announce in the channel.\n\nRollback is documented in ops/runbook.md.\n";
const DEPLOY_DIFF = [
  "diff --git a/deploy-old.md b/deploy-new.md",
  "index 2fdece6..bd9f34b 100644",
  "--- a/deploy-old.md",
  "+++ b/deploy-new.md",
  "@@ -1,7 +1,8 @@",
  " Deploy checklist",
  " ",
  " 1. Run the test suite.",
  "-2. Tag the release.",
  "-3. Announce in the channel.",
  "+2. Run the migration.",
  "+3. Tag the release.",
  "+4. Announce in the channel.",
  " ",
  "-Rollback is documented in the runbook.",
  "+Rollback is documented in ops/runbook.md.",
].join("\n");

// Captured: git diff --no-index iface-old.md iface-new.md (pure replacements)
const NOTES_BASE = "Shipped on Jan 3.\n\nKnown issues: none.\n";
const NOTES_NEW = "Shipped on March 3.\n\nKnown issues: see the tracker.\n";
const NOTES_DIFF = [
  "diff --git a/iface-old.md b/iface-new.md",
  "index 5a368f9..ecc1485 100644",
  "--- a/iface-old.md",
  "+++ b/iface-new.md",
  "@@ -1,3 +1,3 @@",
  "-Shipped on Jan 3.",
  "+Shipped on March 3.",
  " ",
  "-Known issues: none.",
  "+Known issues: see the tracker.",
].join("\n");

// Captured: git diff --no-index h-old.md h-new.md (two hunks, well separated). The
// second header keeps git's trailing context text after "@@"; the parser reads the
// numbers and starts the body at the next line.
const HUNKED_BASE =
  "line one\nline two\nline three\nline four\nline five\nline six\nline seven\nline eight\nline nine\nline ten\nline eleven\nline twelve\n";
const HUNKED_NEW =
  "line one\nLINE TWO\nline three\nline four\nline five\nline six\nline seven\nline eight\nline nine\nline ten\nLINE ELEVEN\nline twelve\n";
const HUNKED_DIFF = `diff --git a/h-old.md b/h-new.md
index d0bc50e..03b89f8 100644
--- a/h-old.md
+++ b/h-new.md
@@ -1,5 +1,5 @@
 line one
-line two
+LINE TWO
 line three
 line four
 line five
@@ -8,5 +8,5 @@ line seven
 line eight
 line nine
 line ten
-line eleven
+LINE ELEVEN
 line twelve
`;

// Captured: git diff --no-index nn-old.md nn-new.md (old ends with newline, new does not)
const NN_ADD_DIFF = `diff --git a/nn-old.md b/nn-new.md
index 814f4a4..530cc72 100644
--- a/nn-old.md
+++ b/nn-new.md
@@ -1,2 +1,2 @@
 one
-two
+TWO
\\ No newline at end of file
`;

// Captured: git diff --no-index nr-old.md nr-new.md (old lacks the newline, new has one)
const NN_REMOVE_DIFF = `diff --git a/nr-old.md b/nr-new.md
index 530cc72..814f4a4 100644
--- a/nr-old.md
+++ b/nr-new.md
@@ -1,2 +1,2 @@
 one
-TWO
\\ No newline at end of file
+two
`;

// Captured: git diff --no-index nc-old.md nc-new.md — real git puts the marker after
// the trailing CONTEXT line when that line is unchanged but lacks a newline.
const NN_CONTEXT_DIFF = `diff --git a/nc-old.md b/nc-new.md
index 54d55bf..a9beb14 100644
--- a/nc-old.md
+++ b/nc-new.md
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
\\ No newline at end of file
`;

// Captured: git diff --no-index crlf-old.md crlf-new.md — headers use LF, hunk body
// lines carry the document's own CR before the LF.
const CRLF_DIFF =
  "diff --git a/crlf-old.md b/crlf-new.md\nindex 2e11fe5..577f794 100644\n--- a/crlf-old.md\n+++ b/crlf-new.md\n@@ -1,3 +1,3 @@\n first\r\n-second\r\n+SECOND\r\n third\r\n";

test("a captured git diff applies byte-for-byte", () => {
  const applied = applyUnifiedDiff(DEPLOY_BASE, DEPLOY_DIFF);
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.results.map((entry) => entry.status), ["applied"]);
  assert.equal(applied.content, DEPLOY_NEW);
});

test("a captured replacement diff applies byte-for-byte", () => {
  const applied = applyUnifiedDiff(NOTES_BASE, NOTES_DIFF);
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.results, [{ index: 0, status: "applied" }]);
  assert.equal(applied.content, NOTES_NEW);
});

test("a captured multi-hunk diff applies every hunk byte-for-byte", () => {
  const applied = applyUnifiedDiff(HUNKED_BASE, HUNKED_DIFF);
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.results.map((entry) => entry.status), ["applied", "applied"]);
  assert.equal(applied.content, HUNKED_NEW);
});

test("a pure insertion into an empty document works", () => {
  const applied = applyUnifiedDiff("", "@@ -0,0 +1 @@\n+hello\n");
  assert.equal(applied.ok, true);
  assert.equal(applied.content, "hello\n");
  assert.deepEqual(applied.results, [{ index: 0, status: "applied" }]);
});

test("a pure deletion down to an empty document works", () => {
  const applied = applyUnifiedDiff("one\ntwo\n", "@@ -1,2 +0,0 @@\n-one\n-two\n");
  assert.equal(applied.ok, true);
  assert.equal(applied.content, "");
  assert.deepEqual(applied.results, [{ index: 0, status: "applied" }]);
});

test("a context mismatch is reported and skipped while the other hunk applies", () => {
  const diff = [
    "@@ -1,2 +1,2 @@",
    "-delta",
    "+DELTA",
    " alpha",
    "@@ -3 +3 @@",
    "-gamma",
    "+GAMMA",
  ].join("\n");
  const applied = applyUnifiedDiff("alpha\nbeta\ngamma\n", diff);
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.results.map((entry) => entry.status), ["context-mismatch", "applied"]);
  assert.equal(applied.results[0].reason, 'line 1: expected "delta", found "alpha"');
  assert.equal(applied.content, "alpha\nbeta\nGAMMA\n");
});

test("a malformed hunk header is refused with an error, never guessed around", () => {
  const parsed = parseUnifiedDiff("@@ totally broken\n one\n");
  assert.equal(parsed.ok, false);
  assert.match(parsed.errors[0].message, /malformed hunk header/);

  const applied = applyUnifiedDiff("one\n", "@@ totally broken\n one\n");
  assert.equal(applied.ok, false);
  assert.match(applied.errors[0].message, /malformed hunk header/);
});

test("declared counts that disagree with the body are reported per hunk", () => {
  const applied = applyUnifiedDiff("one\ntwo\n", "@@ -1,3 +1,3 @@\n-one\n+ONE\n two\n");
  assert.equal(applied.ok, true);
  assert.equal(applied.results[0].status, "malformed");
  assert.match(applied.results[0].reason, /declared counts/);
  assert.equal(applied.content, "one\ntwo\n", "a malformed hunk must leave the document untouched");
});

test("a multi-file diff is refused: one document per envelope", () => {
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1 +1 @@",
    "-c",
    "+d",
  ].join("\n");
  const applied = applyUnifiedDiff("a\n", diff);
  assert.equal(applied.ok, false);
  assert.ok(
    applied.errors.some((entry) => /one document per envelope/.test(entry.message)),
    JSON.stringify(applied.errors),
  );
});

test("a captured CRLF diff keeps the document CRLF, byte-for-byte", () => {
  const applied = applyUnifiedDiff("first\r\nsecond\r\nthird\r\n", CRLF_DIFF);
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.results.map((entry) => entry.status), ["applied"]);
  assert.equal(applied.content, "first\r\nSECOND\r\nthird\r\n");
});

test("a captured marker on the remove side grants the new side its newline", () => {
  const applied = applyUnifiedDiff("one\nTWO", NN_REMOVE_DIFF);
  assert.equal(applied.ok, true);
  assert.equal(applied.content, "one\ntwo\n");
});

test("a captured marker on the add side strips the trailing newline", () => {
  const applied = applyUnifiedDiff("one\ntwo\n", NN_ADD_DIFF);
  assert.equal(applied.ok, true);
  assert.equal(applied.content, "one\nTWO");
});

test("a captured marker after a context line — what real git emits — round-trips", () => {
  const applied = applyUnifiedDiff("one\ntwo\nthree", NN_CONTEXT_DIFF);
  assert.equal(applied.ok, true);
  assert.equal(applied.content, "one\nTWO\nthree");
});

test("an unclassifiable line is quoted with a truncated excerpt", () => {
  const parsed = parseUnifiedDiff(`zzz ${"q".repeat(80)}`);
  assert.equal(parsed.ok, false);
  const message = parsed.errors[0].message;
  assert.match(message, /unrecognized line outside a hunk/);
  assert.match(message, /\.\.\./);
  assert.ok(message.length < 120, `message was not truncated: ${message.length} chars`);
});
