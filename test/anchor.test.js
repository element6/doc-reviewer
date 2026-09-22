import assert from "node:assert/strict";
import test from "node:test";

import { ANCHOR_CONTEXT_CHARS, MAX_QUOTE_CHARS } from "../src/contract.js";
import { anchorFromText, describeAnchor, isAnchorStale, locateAnchor } from "../src/anchor.js";

test("a quote occurring twice yields occurrence 0 then 1", () => {
  const sourceText = "The cat sat. Another cat sat.";
  const firstStart = sourceText.indexOf("cat");
  const first = anchorFromText({ sourceText, start: firstStart, end: firstStart + 3 });
  const secondStart = sourceText.lastIndexOf("cat");
  const second = anchorFromText({ sourceText, start: secondStart, end: secondStart + 3 });
  assert.equal(first.occurrence, 0);
  assert.equal(second.occurrence, 1);
});

test("locateAnchor finds the anchor exactly after unrelated text is inserted before it", () => {
  const sourceText = "Introduction paragraph with several words. TARGET here.";
  const start = sourceText.indexOf("TARGET");
  const anchor = anchorFromText({ sourceText, start, end: start + 6 });

  const inserted = "Extra preamble. ";
  const shifted = inserted + sourceText;
  const located = locateAnchor(shifted, anchor);
  assert.equal(located.exact, true);
  assert.equal(located.start, start + inserted.length);
  assert.equal(shifted.slice(located.start, located.end), "TARGET");
});

test("locateAnchor falls back with exact false when context changed but the quote survives", () => {
  const sourceText = "Alpha TARGET omega.";
  const anchor = anchorFromText({ sourceText, start: 6, end: 12 });

  const changed = "Zulu TARGET omega.";
  const located = locateAnchor(changed, anchor);
  assert.equal(located.start, changed.indexOf("TARGET"));
  assert.equal(located.exact, false);
  assert.equal(isAnchorStale(changed, anchor), false);
});

test("an anchor whose quote was deleted is stale", () => {
  const sourceText = "Alpha TARGET omega.";
  const anchor = anchorFromText({ sourceText, start: 6, end: 12 });

  const changed = "Alpha omega.";
  assert.deepEqual(locateAnchor(changed, anchor), { start: -1, end: -1, exact: false });
  assert.equal(isAnchorStale(changed, anchor), true);
  assert.equal(isAnchorStale(sourceText, anchor), false);
});

test("prefix and suffix never exceed the context cap", () => {
  assert.equal(ANCHOR_CONTEXT_CHARS, 40);
  const sourceText = `${"p".repeat(60)}SEED${"s".repeat(60)}`;
  const anchor = anchorFromText({ sourceText, start: 60, end: 64 });
  assert.equal(anchor.prefix.length, ANCHOR_CONTEXT_CHARS);
  assert.equal(anchor.suffix.length, ANCHOR_CONTEXT_CHARS);
  assert.equal(anchor.prefix, "p".repeat(40));
  assert.equal(anchor.suffix, "s".repeat(40));

  const nearStart = anchorFromText({ sourceText: "tiny SEED rest", start: 5, end: 9 });
  assert.equal(nearStart.prefix, "tiny ");
});

test("a quote longer than the cap is truncated and stays locatable", () => {
  const sourceText = "y".repeat(4100) + "END";
  const anchor = anchorFromText({ sourceText, start: 0, end: 4050 });
  assert.equal(anchor.quote.length, MAX_QUOTE_CHARS);
  assert.deepEqual(anchor.offset, { start: 0, end: MAX_QUOTE_CHARS });

  const located = locateAnchor(sourceText, anchor);
  assert.equal(located.start, 0);
  assert.equal(located.exact, true);
});

test("element anchors carry selector, blockId, and kind element", () => {
  const sourceText = "<p>Selected text</p>";
  const start = sourceText.indexOf("Selected");
  const anchor = anchorFromText({
    sourceText,
    start,
    end: start + 8,
    selector: "p:nth-of-type(1)",
    blockId: "b1",
    label: "paragraph 1",
  });
  assert.equal(anchor.kind, "element");
  assert.equal(anchor.selector, "p:nth-of-type(1)");
  assert.equal(anchor.blockId, "b1");
  assert.equal(anchor.label, "paragraph 1");

  const plain = anchorFromText({ sourceText, start, end: start + 8 });
  assert.equal(plain.kind, "text");
  assert.equal(plain.selector, undefined);
  assert.equal(plain.blockId, undefined);
});

test("inverted, empty, and out-of-range ranges return null", () => {
  const sourceText = "0123456789";
  assert.equal(anchorFromText({ sourceText, start: 7, end: 3 }), null);
  assert.equal(anchorFromText({ sourceText, start: 4, end: 4 }), null);
  assert.equal(anchorFromText({ sourceText, start: -1, end: 4 }), null);
  assert.equal(anchorFromText({ sourceText, start: 0, end: 11 }), null);
});

test("describeAnchor is deterministic for the labelled and context forms", () => {
  assert.equal(describeAnchor({ kind: "text", quote: "TARGET", label: "quote" }), 'label: "quote"');

  const context = { kind: "text", quote: "TARGET", prefix: "Alpha beta ", suffix: " gamma" };
  const expected = "...Alpha beta «TARGET» gamma...";
  assert.equal(describeAnchor(context), expected);
  assert.equal(describeAnchor(context), expected);
});

test("an explicitly supplied quote is honored verbatim", () => {
  const sourceText = '<p class="lead">Alpha TARGET omega.</p>';
  const anchor = anchorFromText({
    sourceText,
    start: 0,
    end: sourceText.length,
    kind: "element",
    quote: "Alpha TARGET omega.",
    selector: "p.lead",
    blockId: "b1",
  });
  assert.equal(anchor.quote, "Alpha TARGET omega.");
  assert.equal(anchor.kind, "element");
  assert.deepEqual(anchor.offset, { start: 0, end: sourceText.length });
  assert.equal(anchor.prefix, "");
  assert.equal(anchor.suffix, "");
  assert.equal(anchor.occurrence, 0);
  assert.equal(anchor.selector, "p.lead");

  assert.equal(anchorFromText({ sourceText, start: 0, end: 4, quote: "" }), null);
});
