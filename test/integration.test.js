/**
 * Integration gate over the pure pipeline: contract -> blocks -> hunks -> state -> feedback.
 *
 * Each module is unit-tested by its own suite. This file exists to catch the failure the
 * unit suites cannot see: two modules whose contracts disagree about the *shape* of the
 * data passed between them. It therefore exercises the whole chain and asserts the two
 * document-level round-trip invariants that matter to the user.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { anchorFromText, locateAnchor } from "../src/anchor.js";
import { ENVELOPE_SCHEMA, applyProposal, parseEnvelope, validateFeedback } from "../src/contract.js";
import { diffSegments, hunksFromBlocks, validDiff } from "../src/diff.js";
import { parseHash } from "../src/channels/hash.js";
import { extractBlocks } from "../src/html-blocks.js";
import { isAllowedAttribute, isAllowedTag, isSafeUrl } from "../src/sanitize.js";
import { buildFeedbackPayload, createSession, decideAll, resultContent, setManualEdit } from "../src/state.js";

const MARKDOWN_BASE = [
  "Release notes",
  "",
  "We shipped on Jan 3.",
  "",
  "Known issues: none.",
].join("\n");

const MARKDOWN_PROPOSED = [
  "Release notes",
  "",
  "We shipped on March 3.",
  "",
  "Known issues: see the tracker.",
].join("\n");

function envelopeFor(base, proposed, options = {}) {
  return {
    schema: ENVELOPE_SCHEMA,
    requestId: "integration-1",
    doc: {
      id: "release-notes",
      title: "Release notes",
      format: options.format ?? "markdown",
      revision: 1,
      content: base,
    },
    proposal: { kind: "replace", content: proposed, summary: "Corrected dates." },
    options: options.options ?? {},
  };
}

/** Run the whole pure pipeline the way main.js does. */
function pipeline(envelopeLike) {
  const parsed = parseEnvelope(envelopeLike);
  assert.equal(parsed.ok, true, `envelope rejected: ${JSON.stringify(parsed.errors)}`);
  const { envelope } = parsed;

  const { content: proposedContent, opResults } = applyProposal(envelope.doc, envelope.proposal);
  const baseBlocks = extractBlocks(envelope.doc.content, envelope.doc.format);
  const proposedBlocks = extractBlocks(proposedContent, envelope.doc.format);
  const result = hunksFromBlocks(baseBlocks, proposedBlocks);
  assert.equal(result.ok, true, `hunksFromBlocks refused: ${result.reason}`);

  const session = createSession({ envelope, proposedContent, hunks: result.hunks, opResults });
  return { envelope, session, proposedContent, baseBlocks, proposedBlocks, opResults };
}

test("blocks partition every format byte-for-byte", () => {
  const cases = [
    ["html", "<p>One</p>\n<p>Two</p>"],
    ["html", "<div><p>Nested <em>text</em></p></div>"],
    ["html", "  <p>Leading space</p>  <p>Trailing</p>  "],
    ["html", "<p>Repeated</p>\n<p>Repeated</p>"],
    ["html", "<p>Attr with &gt; inside</p>"],
    ["html", "<ul><li>a</li><li>b</li></ul>"],
    ["html", "<p>before</p><!-- comment --><p>after</p>"],
    ["html", "loose text\n<p>element</p>\nmore text"],
    ["markdown", "# Title\n\nBody text.\n\n- one\n- two"],
    ["text", "Plain words.\n\nSecond paragraph."],
    ["text", ""],
    ["markdown", "no blank lines at all"],
  ];
  for (const [format, content] of cases) {
    const blocks = extractBlocks(content, format);
    const rejoined = blocks.map((block) => block.html).join("");
    assert.equal(rejoined, content, `partition broke for ${format}: ${JSON.stringify(content)}`);
  }
});

test("accepting every hunk reproduces the proposed document exactly", () => {
  const { session, proposedContent } = pipeline(envelopeFor(MARKDOWN_BASE, MARKDOWN_PROPOSED));
  assert.equal(resultContent(decideAll(session, "accepted")), proposedContent);
});

test("rejecting every hunk reproduces the base document exactly", () => {
  const { session, envelope } = pipeline(envelopeFor(MARKDOWN_BASE, MARKDOWN_PROPOSED));
  assert.equal(resultContent(decideAll(session, "rejected")), envelope.doc.content);
});

test("the round-trip invariants also hold for an HTML document", () => {
  const base = "<h1>Title</h1>\n<p>We shipped on Jan 3.</p>\n<p>Known issues: none.</p>";
  const proposed = "<h1>Title</h1>\n<p>We shipped on March 3.</p>\n<p>Known issues: see tracker.</p>";
  const { session, envelope, proposedContent } = pipeline(envelopeFor(base, proposed, { format: "html" }));
  assert.equal(resultContent(decideAll(session, "accepted")), proposedContent);
  assert.equal(resultContent(decideAll(session, "rejected")), envelope.doc.content);
});

test("a partially accepted review takes each hunk from its own side", () => {
  const { session, proposedContent } = pipeline(envelopeFor(MARKDOWN_BASE, MARKDOWN_PROPOSED));
  const accepted = decideAll(session, "rejected");
  const changed = accepted.hunks.filter((hunk) => hunk.kind !== "removed");
  assert.ok(changed.length >= 2, `expected at least two change hunks, got ${changed.length}`);

  let mixed = accepted;
  // Accept exactly the first change hunk and leave the rest rejected.
  const first = changed[0];
  mixed = { ...mixed, decisions: { ...mixed.decisions, [first.id]: "accepted" } };

  const output = resultContent(mixed);
  assert.ok(output.includes(first.proposedText.trim().slice(0, 12)), "accepted hunk text missing");
  assert.ok(output.length > 0);
  assert.notEqual(output, proposedContent, "a partial acceptance must not equal the full proposal");
});

test("a manual edit lands in the result and is reported as edited", () => {
  const { session } = pipeline(envelopeFor(MARKDOWN_BASE, MARKDOWN_PROPOSED));
  // Edits are matched structurally through the hunk's block id, never by comparing
  // text: a hand edit by definition differs from proposedText.
  const target = session.hunks.find((hunk) => hunk.kind !== "removed" && hunk.proposedBlockId);
  assert.ok(target, "expected a change hunk carrying a proposed block id");

  const edited = setManualEdit(session, target.proposedBlockId, "We shipped on the 5th.");
  const output = resultContent(edited);
  assert.ok(output.includes("We shipped on the 5th."), "manual edit missing from result");
  assert.ok(
    Object.values(edited.decisions).includes("edited"),
    "a hand-edited hunk must be reported as edited",
  );

  const payload = buildFeedbackPayload(edited);
  assert.equal(validateFeedback(payload).ok, true, JSON.stringify(validateFeedback(payload).errors));
});

test("the feedback payload validates for all three verdicts", () => {
  const { session } = pipeline(envelopeFor(MARKDOWN_BASE, MARKDOWN_PROPOSED));

  const fullyRejected = buildFeedbackPayload(decideAll(session, "rejected"));
  assert.equal(fullyRejected.verdict, "rejected");
  assert.equal(validateFeedback(fullyRejected).ok, true);

  const fullyAccepted = buildFeedbackPayload(decideAll(session, "accepted"));
  assert.equal(fullyAccepted.verdict, "accepted");
  assert.equal(validateFeedback(fullyAccepted).ok, true);

  const untouched = buildFeedbackPayload(session);
  assert.equal(untouched.verdict, "changes-requested");
  assert.equal(validateFeedback(untouched).ok, true);
  assert.equal(untouched.requestId, "integration-1");
  assert.deepEqual(untouched.doc, { id: "release-notes", revision: 1 });
});

test("a comment anchored before an edit still resolves afterwards", () => {
  const { session } = pipeline(envelopeFor(MARKDOWN_BASE, MARKDOWN_PROPOSED));
  const start = MARKDOWN_BASE.indexOf("Jan 3");
  const anchor = anchorFromText({ sourceText: MARKDOWN_BASE, start, end: start + 5, label: "paragraph 2" });
  assert.ok(anchor);
  assert.equal(anchor.quote, "Jan 3");

  const accepted = decideAll(session, "accepted");
  const relocated = locateAnchor(resultContent(accepted), anchor);
  assert.equal(relocated.start, -1, "the commented words were replaced, so the anchor is stale");

  const rejected = decideAll(session, "rejected");
  const stable = locateAnchor(resultContent(rejected), anchor);
  assert.equal(stable.start, start, "rejecting everything must leave the anchor where it was");
});

test("every hunk's parts satisfy the diff reconstruction invariant", () => {
  const { session } = pipeline(envelopeFor(MARKDOWN_BASE, MARKDOWN_PROPOSED));
  assert.ok(session.hunks.length > 0, "expected at least one hunk");
  for (const hunk of session.hunks) {
    if (hunk.parts === null) continue;
    assert.equal(
      validDiff(hunk.baseText, hunk.proposedText, hunk.parts),
      true,
      `hunk ${hunk.id} parts do not reconstruct its texts`,
    );
    const direct = diffSegments(hunk.baseText, hunk.proposedText);
    assert.equal(direct.ok, true);
    assert.equal(validDiff(hunk.baseText, hunk.proposedText, direct.parts), true);
  }
});

test("unresolved patch operations surface instead of silently vanishing", () => {
  const envelope = envelopeFor(MARKDOWN_BASE, MARKDOWN_PROPOSED);
  envelope.proposal = {
    kind: "patch",
    ops: [
      { op: "replace", find: "Jan 3", replace: "March 3" },
      { op: "delete", find: "text that is not present" },
    ],
  };
  const { opResults } = pipeline(envelope);
  assert.deepEqual(opResults.map((entry) => entry.status), ["applied", "not-found"]);
});

test("the sanitizer policy refuses script vectors and allows prose markup", () => {
  assert.equal(isSafeUrl("javascript:alert(1)"), false);
  assert.equal(isSafeUrl("JaVaScRiPt:alert(1)"), false);
  assert.equal(isSafeUrl("java\tscript:alert(1)"), false);
  assert.equal(isSafeUrl("vbscript:msgbox(1)"), false);
  assert.equal(isSafeUrl("data:text/html,<script>1</script>"), false);
  assert.equal(isSafeUrl("data:image/png;base64,AAAA"), true);
  assert.equal(isSafeUrl("https://example.com"), true);
  assert.equal(isSafeUrl("relative/path.html"), true);
  assert.equal(isSafeUrl("#fragment"), true);

  assert.equal(isAllowedTag("p"), true);
  assert.equal(isAllowedTag("P"), true);
  assert.equal(isAllowedTag("script"), false);
  assert.equal(isAllowedTag("iframe"), false);
  assert.equal(isAllowedTag("form"), false);

  assert.equal(isAllowedAttribute("a", "href", "https://example.com"), true);
  assert.equal(isAllowedAttribute("a", "href", "javascript:alert(1)"), false);
  assert.equal(isAllowedAttribute("img", "onerror", "alert(1)"), false);
  assert.equal(isAllowedAttribute("p", "onclick", "alert(1)"), false);
  assert.equal(isAllowedAttribute("p", "style", "background:url(javascript:1)"), false);
});

test("fragment parsing recognizes both channels and rejects junk", () => {
  assert.deepEqual(parseHash("#src=https://example.com/a.json"), {
    kind: "url",
    url: "https://example.com/a.json",
  });
  assert.equal(parseHash("#d=abc").kind, "envelope");
  assert.equal(parseHash("d=abc").kind, "envelope");
  assert.equal(parseHash(""), null);
  assert.equal(parseHash("#"), null);
  assert.equal(parseHash("#unrelated=1"), null);
  // An empty payload may be refused outright or surfaced for the decoder to reject;
  // either is acceptable, but it must never throw.
  const empty = parseHash("#d=");
  assert.ok(empty === null || empty.kind === "envelope", `unexpected empty-payload result: ${JSON.stringify(empty)}`);
});
