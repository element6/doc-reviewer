import assert from "node:assert/strict";
import test from "node:test";

import { ENVELOPE_SCHEMA, validateFeedback } from "../src/contract.js";
import {
  addComment,
  buildFeedbackPayload,
  createSession,
  decide,
  decideAll,
  redo,
  removeComment,
  resultContent,
  setManualEdit,
  setDocumentOverride,
  undo,
} from "../src/state.js";

const BASE = "Alpha beta.\n\nGamma delta.\n\nEpsilon zeta.";
const PROPOSED = "Alpha beta.\n\nGamma DELTA.\n\nEpsilon ZETA.";

function fixtureHunks() {
  return [
    {
      id: "h1",
      kind: "changed",
      baseText: "Gamma delta.",
      proposedText: "Gamma DELTA.",
      parts: [],
      baseOffset: 13,
      baseBlockId: "b-mid",
      proposedBlockId: "p-mid",
    },
    {
      id: "h2",
      kind: "changed",
      baseText: "Epsilon zeta.",
      proposedText: "Epsilon ZETA.",
      parts: [],
      baseOffset: 27,
      baseBlockId: "b-tail",
      proposedBlockId: "p-tail",
    },
  ];
}

function fixtureBlocks() {
  return [
    { blockId: "b-intro", kind: "chunk", html: "Alpha beta.", text: "Alpha beta.", offset: 0, endOffset: 11 },
    { blockId: "b-gap1", kind: "chunk", html: "\n\n", text: "", offset: 11, endOffset: 13 },
    { blockId: "b-mid", kind: "chunk", html: "Gamma delta.", text: "Gamma delta.", offset: 13, endOffset: 25 },
    { blockId: "b-gap2", kind: "chunk", html: "\n\n", text: "", offset: 25, endOffset: 27 },
    { blockId: "b-tail", kind: "chunk", html: "Epsilon zeta.", text: "Epsilon zeta.", offset: 27, endOffset: 40 },
  ];
}

function envelope() {
  return {
    schema: ENVELOPE_SCHEMA,
    requestId: "req-1",
    doc: { id: "d1", title: "Fixture", format: "markdown", revision: 1, content: BASE },
    proposal: { kind: "replace", content: PROPOSED },
    options: {},
  };
}

function fresh() {
  return createSession({
    envelope: envelope(),
    proposedContent: PROPOSED,
    hunks: fixtureHunks(),
    baseBlocks: fixtureBlocks(),
    opResults: [],
  });
}

const ANCHOR = {
  kind: "text",
  quote: "Gamma delta.",
  prefix: "",
  suffix: "",
  occurrence: 0,
  offset: { start: 13, end: 25 },
};

test("rejecting every hunk reproduces the envelope content byte-for-byte", () => {
  assert.equal(resultContent(decideAll(fresh(), "rejected")), envelope().doc.content);
});

test("accepting every hunk reproduces the proposed content byte-for-byte", () => {
  assert.equal(resultContent(decideAll(fresh(), "accepted")), PROPOSED);
});

test("mixed decisions take each hunk from its own side", () => {
  const acceptedFirst = decide(decide(fresh(), "h1", "accepted"), "h2", "rejected");
  assert.equal(resultContent(acceptedFirst), "Alpha beta.\n\nGamma DELTA.\n\nEpsilon zeta.");

  const acceptedSecond = decide(decide(fresh(), "h1", "rejected"), "h2", "accepted");
  assert.equal(resultContent(acceptedSecond), "Alpha beta.\n\nGamma delta.\n\nEpsilon ZETA.");

  const partial = decide(fresh(), "h1", "accepted");
  assert.equal(resultContent(partial), "Alpha beta.\n\nGamma DELTA.\n\nEpsilon zeta.");
});

test("decide with an unknown hunk id warns and changes nothing else", () => {
  const session = fresh();
  const next = decide(session, "nope", "accepted");
  assert.notEqual(next, session);
  assert.deepEqual(next.decisions, session.decisions);
  assert.equal(next.warnings.length, 1);
  assert.match(next.warnings[0], /unknown hunk "nope"/);
  assert.equal(session.warnings.length, 0, "the input session must stay untouched");
});

test("decide with an invalid decision warns and changes nothing else", () => {
  const session = fresh();
  const next = decide(session, "h1", "maybe");
  assert.deepEqual(next.decisions, session.decisions);
  assert.equal(next.warnings.length, 1);
  assert.match(next.warnings[0], /invalid decision "maybe"/);
  assert.equal(session.warnings.length, 0);
});

test("decideAll leaves hand-edited hunks alone", () => {
  const edited = setManualEdit(fresh(), "p-mid", "Gamma MANUAL.");
  const settled = decideAll(edited, "accepted");
  assert.equal(settled.decisions.h1, "edited");
  assert.equal(settled.decisions.h2, "accepted");
});

test("a manual edit on a covered block becomes the result text for that hunk", () => {
  const edited = setManualEdit(fresh(), "p-mid", "Gamma MANUAL.");
  assert.equal(edited.decisions.h1, "edited");
  assert.equal(edited.decisions.h2, "unresolved");
  const output = resultContent(edited);
  assert.equal(output, "Alpha beta.\n\nGamma MANUAL.\n\nEpsilon zeta.");
  assert.ok(!output.includes("Gamma DELTA."), "the untouched proposal text must not leak in");
  assert.equal(edited.edits["p-mid"], "Gamma MANUAL.");
  assert.equal(fresh().edits["p-mid"], undefined, "the input session must stay untouched");
});

test("a manual edit to a block no hunk covers survives into result and feedback", () => {
  const edited = setManualEdit(fresh(), "b-intro", "Beta ALPHA.");
  const settled = decideAll(edited, "accepted");
  assert.equal(resultContent(settled), "Beta ALPHA.\n\nGamma DELTA.\n\nEpsilon ZETA.");
  assert.equal(settled.hunks.filter((hunk) => hunk.id === "edit:b-intro").length, 1);

  const payload = buildFeedbackPayload(settled);
  const synthetic = payload.hunks.find((hunk) => hunk.id === "edit:b-intro");
  assert.equal(synthetic.decision, "edited");
  assert.equal(payload.verdict, "accepted");
  assert.equal(validateFeedback(payload).ok, true, JSON.stringify(validateFeedback(payload).errors));
});

test("undo and redo restore prior content and decisions exactly", () => {
  const s0 = fresh();
  const s1 = decide(s0, "h1", "accepted");
  const s2 = decide(s1, "h2", "accepted");
  const s3 = addComment(s2, ANCHOR, "Looks good.");
  assert.equal(resultContent(s1), "Alpha beta.\n\nGamma DELTA.\n\nEpsilon zeta.");

  const back2 = undo(s3);
  assert.deepEqual(back2.decisions, s2.decisions);
  assert.equal(back2.comments.length, 0);
  assert.equal(resultContent(back2), PROPOSED);

  const back1 = undo(back2);
  assert.deepEqual(back1.decisions, s1.decisions);
  assert.equal(resultContent(back1), "Alpha beta.\n\nGamma DELTA.\n\nEpsilon zeta.");

  const back0 = undo(back1);
  assert.deepEqual(back0.decisions, s0.decisions);
  assert.equal(resultContent(back0), BASE);
  assert.equal(back0.past.length, 0);

  const forward1 = redo(back0);
  assert.deepEqual(forward1.decisions, s1.decisions);
  assert.equal(resultContent(forward1), "Alpha beta.\n\nGamma DELTA.\n\nEpsilon zeta.");

  const forward2 = redo(forward1);
  assert.deepEqual(forward2.decisions, s2.decisions);
  assert.equal(resultContent(forward2), PROPOSED);

  const forward3 = redo(forward2);
  assert.deepEqual(forward3.decisions, s3.decisions);
  assert.equal(forward3.comments.length, 1);
  assert.equal(resultContent(forward3), PROPOSED);

  const branched = decide(undo(s3), "h2", "rejected");
  assert.equal(branched.future.length, 0, "a new mutation must clear the redo stack");
});

test("the past stack is capped at 100 entries", () => {
  let session = fresh();
  for (let i = 0; i < 105; i += 1) {
    session = decide(session, "h1", i % 2 === 0 ? "rejected" : "accepted");
  }
  assert.equal(session.past.length, 100);
});

test("comments get sequential ids and remove cleanly", () => {
  const session = fresh();
  const withOne = addComment(session, ANCHOR, "first");
  assert.equal(withOne.comments[0].id, "c1");
  assert.match(withOne.comments[0].createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.equal(withOne.comments[0].anchor, ANCHOR);

  const withTwo = addComment(withOne, ANCHOR, "second");
  assert.equal(withTwo.comments[1].id, "c2");
  assert.equal(session.comments.length, 0, "the input session must stay untouched");

  const removed = removeComment(withTwo, "c1");
  assert.deepEqual(removed.comments.map((comment) => comment.body), ["second"]);

  const withThree = addComment(removed, ANCHOR, "third");
  assert.equal(withThree.comments[1].id, "c3");

  const missing = removeComment(withThree, "c9");
  assert.equal(missing.comments.length, 2);
  assert.match(missing.warnings[missing.warnings.length - 1], /comment "c9" not found/);
});

test("buildFeedbackPayload produces a payload that passes validateFeedback", () => {
  const settled = decide(decide(fresh(), "h1", "accepted"), "h2", "rejected");
  const withComment = addComment(settled, ANCHOR, "Please reword.");
  const payload = buildFeedbackPayload(withComment);

  const check = validateFeedback(payload);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  assert.equal(payload.requestId, "req-1");
  assert.deepEqual(payload.doc, { id: "d1", revision: 1 });
  assert.equal(payload.result.format, "markdown");
  assert.equal(payload.result.content, resultContent(withComment));
  assert.equal(payload.hunks.length, 2);
  assert.equal(payload.hunks[0].decision, "accepted");
  assert.equal(payload.hunks[0].base, "Gamma delta.");
  assert.equal(payload.hunks[0].proposed, "Gamma DELTA.");
  assert.equal(payload.comments[0].body, "Please reword.");
  assert.deepEqual(payload.comments[0].anchor, ANCHOR);
});

test("verdict selection covers all three verdicts", () => {
  assert.equal(buildFeedbackPayload(fresh()).verdict, "changes-requested");

  const partial = decide(fresh(), "h1", "accepted");
  assert.equal(buildFeedbackPayload(partial).verdict, "changes-requested");

  const accepted = decideAll(fresh(), "accepted");
  assert.equal(buildFeedbackPayload(accepted).verdict, "accepted");

  const rejected = decideAll(fresh(), "rejected");
  assert.equal(buildFeedbackPayload(rejected).verdict, "rejected");

  let allEdited = fresh();
  allEdited = decide(allEdited, "h1", "edited");
  allEdited = decide(allEdited, "h2", "edited");
  assert.equal(buildFeedbackPayload(allEdited).verdict, "accepted");
});

test("a hunk whose base text is missing warns instead of throwing", () => {
  const session = fresh();
  const broken = {
    ...session,
    hunks: [
      ...session.hunks,
      {
        id: "hx",
        kind: "changed",
        baseText: "no such slice",
        proposedText: "replacement",
        parts: [],
        baseOffset: 5,
        baseBlockId: "b-ghost",
        proposedBlockId: "p-ghost",
      },
    ],
    decisions: { ...session.decisions, hx: "accepted" },
  };

  let output;
  assert.doesNotThrow(() => {
    output = resultContent(broken);
  });
  assert.equal(typeof output, "string");
  assert.ok(
    broken.warnings.some((message) => message.includes("base text not found")),
    JSON.stringify(broken.warnings),
  );
  assert.equal(output, BASE, "the skipped hunk leaves the document intact");
  assert.equal(session.warnings.length, 0, "the input session must stay untouched");
});

test("a document override replaces the composed result", () => {
  const session = fresh();
  const override = "# Rewritten\n\nThe human took over this document.";
  const overridden = setDocumentOverride(session, override);
  assert.equal(resultContent(overridden), override);
  assert.deepEqual(Object.values(overridden.decisions), ["edited", "edited"]);
  assert.equal(session.override, null, "the input session must stay untouched");
});

test("clearing the override restores base-plus-decisions composition", () => {
  const overridden = setDocumentOverride(fresh(), "Rewrite text.");
  const cleared = setDocumentOverride(overridden, null);
  assert.equal(cleared.override, null);
  assert.notEqual(resultContent(cleared), "Rewrite text.");
  // Setting the override marked every hunk edited, and clearing leaves decisions
  // alone, so composition resumes on the proposed side of each hunk.
  assert.equal(resultContent(cleared), PROPOSED);

  const decided = decide(cleared, "h1", "rejected");
  assert.equal(resultContent(decided), "Alpha beta.\n\nGamma delta.\n\nEpsilon ZETA.");
});

test("any hunk-level mutation ends source mode", () => {
  const override = setDocumentOverride(fresh(), "Rewrite text.");

  const afterDecide = decide(override, "h1", "rejected");
  assert.equal(afterDecide.override, null);
  assert.equal(resultContent(afterDecide), "Alpha beta.\n\nGamma delta.\n\nEpsilon ZETA.");

  const afterDecideAll = decideAll(override, "rejected");
  assert.equal(afterDecideAll.override, null);
  assert.equal(resultContent(afterDecideAll), PROPOSED, "bulk decisions still skip edited hunks");

  const afterEdit = setManualEdit(override, "p-mid", "Gamma MANUAL.");
  assert.equal(afterEdit.override, null);
});

test("undo restores a cleared override and redo reapplies it", () => {
  const base = fresh();
  const overridden = setDocumentOverride(base, "Rewrite text.");

  const back = undo(overridden);
  assert.equal(back.override, null);
  assert.deepEqual(back.decisions, base.decisions);
  assert.equal(resultContent(back), BASE);

  const forward = redo(back);
  assert.equal(forward.override, "Rewrite text.");
  assert.equal(resultContent(forward), "Rewrite text.");
});

test("a payload built while an override is set validates and carries the override text", () => {
  const overridden = setDocumentOverride(fresh(), "The override text.");
  const payload = buildFeedbackPayload(overridden);
  assert.equal(payload.result.content, "The override text.");
  assert.equal(payload.result.content, resultContent(overridden));
  assert.equal(payload.verdict, "accepted", "every hunk edited must read as accepted");
  const check = validateFeedback(payload);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
});
