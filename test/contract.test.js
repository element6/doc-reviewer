import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractError,
  ENVELOPE_SCHEMA,
  FEEDBACK_SCHEMA,
  MAX_TITLE_CHARS,
  applyProposal,
  buildFeedback,
  parseEnvelope,
  validateFeedback,
} from "../src/contract.js";

const DOC = {
  id: "d1",
  title: "A document",
  format: "html",
  revision: 1,
  content: "<p>Hello world</p>",
};

function envelope(overrides = {}) {
  return {
    schema: ENVELOPE_SCHEMA,
    requestId: "req-1",
    doc: DOC,
    proposal: { kind: "replace", content: "<p>Hello there</p>" },
    ...overrides,
  };
}

function anchor(overrides = {}) {
  return {
    kind: "text",
    quote: "Hello",
    prefix: "",
    suffix: "",
    occurrence: 0,
    offset: { start: 0, end: 5 },
    ...overrides,
  };
}

test("parseEnvelope accepts a JSON string and an object alike", () => {
  const fromString = parseEnvelope(JSON.stringify(envelope()));
  const fromObject = parseEnvelope(envelope());
  assert.equal(fromString.ok, true);
  assert.equal(fromObject.ok, true);
  assert.deepEqual(fromString.envelope, fromObject.envelope);
  assert.deepEqual(fromString.envelope.options, { allowDirectEdit: true });
  assert.equal(fromString.envelope.doc.content, "<p>Hello world</p>");
});

test("parseEnvelope reports malformed JSON and non-objects without throwing", () => {
  assert.equal(parseEnvelope("{").ok, false);
  assert.match(parseEnvelope("{").errors[0].message, /not valid JSON/);
  assert.equal(parseEnvelope("[]").ok, false);
  assert.equal(parseEnvelope(null).ok, false);
  assert.equal(parseEnvelope(42).ok, false);
});

test("parseEnvelope refuses an unsupported version but names it", () => {
  const result = parseEnvelope(envelope({ schema: "doc-reviewer/envelope@2" }));
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /unsupported envelope version "2"/);
  assert.match(result.errors[0].message, /envelope@1/);
});

test("parseEnvelope warns about unknown fields instead of failing", () => {
  const result = parseEnvelope(
    envelope({ extra: true, doc: { ...DOC, mood: "calm" }, options: { diffGranularity: "auto" } }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, [
    "ignored unknown field $.doc.mood",
    "ignored unknown field $.options.diffGranularity",
    "ignored unknown field $.extra",
  ]);
});

test("parseEnvelope collects every field error at once", () => {
  const result = parseEnvelope({
    schema: ENVELOPE_SCHEMA,
    requestId: "",
    doc: { id: "d1", title: "x".repeat(MAX_TITLE_CHARS + 1), format: "pdf", revision: 0, content: 7 },
    proposal: { kind: "unified" },
  });
  assert.equal(result.ok, false);
  const paths = result.errors.map((error) => error.path).sort();
  assert.deepEqual(paths, [
    "$.doc.content",
    "$.doc.format",
    "$.doc.revision",
    "$.doc.title",
    "$.proposal.diff",
    "$.requestId",
  ]);
});

test("parseEnvelope requires the field each proposal kind needs", () => {
  const noContent = parseEnvelope(envelope({ proposal: { kind: "replace" } }));
  assert.equal(noContent.ok, false);
  assert.equal(noContent.errors[0].path, "$.proposal.content");

  const noDiff = parseEnvelope(envelope({ proposal: { kind: "unified" } }));
  assert.equal(noDiff.ok, false);
  assert.equal(noDiff.errors[0].path, "$.proposal.diff");
});

test("the removed patch format fails validation naming the replacement", () => {
  const kindPatch = parseEnvelope(envelope({ proposal: { kind: "patch" } }));
  assert.equal(kindPatch.ok, false);
  assert.ok(
    kindPatch.errors.some((error) => error.path === "$.proposal.kind" && /unified/.test(error.message)),
    JSON.stringify(kindPatch.errors),
  );

  const opsSent = parseEnvelope(
    envelope({ proposal: { kind: "unified", diff: "@@ -1 +1 @@\n-a\n+b\n", ops: [] } }),
  );
  assert.equal(opsSent.ok, false);
  const opsError = opsSent.errors.find((error) => error.path === "$.proposal.ops");
  assert.ok(opsError, JSON.stringify(opsSent.errors));
  assert.match(opsError.message, /unified/);
});

test("an empty document content is valid", () => {
  const result = parseEnvelope(envelope({ doc: { ...DOC, content: "" } }));
  assert.equal(result.ok, true);
  assert.equal(result.envelope.doc.content, "");
});

test("applyProposal short-circuits a full replacement", () => {
  const replaced = applyProposal({ content: "old" }, { kind: "replace", content: "new" });
  assert.deepEqual(replaced, { content: "new", opResults: [] });
});

test("applyProposal applies a unified diff and reports each hunk", () => {
  const applied = applyProposal(
    { content: "alpha\nbeta\n" },
    { kind: "unified", diff: "@@ -1,2 +1,2 @@\n alpha\n-beta\n+BETA\n" },
  );
  assert.equal(applied.content, "alpha\nBETA\n");
  assert.deepEqual(applied.opResults, [{ index: 0, status: "applied" }]);
});

test("applyProposal leaves the document untouched when a hunk's context misses", () => {
  const applied = applyProposal(
    { content: "alpha\nbeta\n" },
    { kind: "unified", diff: "@@ -1,2 +1,2 @@\n gamma\n-beta\n+BETA\n" },
  );
  assert.equal(applied.content, "alpha\nbeta\n");
  assert.equal(applied.opResults[0].status, "context-mismatch");
  assert.match(applied.opResults[0].reason, /line 1/);
});

test("applyProposal reports a structurally broken diff as malformed without changing the document", () => {
  const applied = applyProposal({ content: "old" }, { kind: "unified", diff: "@@ not a header @@\n" });
  assert.equal(applied.content, "old");
  assert.equal(applied.opResults.length, 1);
  assert.equal(applied.opResults[0].status, "malformed");
  assert.match(applied.opResults[0].reason, /malformed hunk header/);
});

test("buildFeedback maps hunk text onto the schema field names", () => {
  const { envelope: parsed } = parseEnvelope(envelope());
  const feedback = buildFeedback({
    envelope: parsed,
    result: { format: "html", content: "<p>Hello there</p>" },
    verdict: "changes-requested",
    hunks: [{ id: "h1", decision: "accepted", baseText: "world", proposedText: "there" }],
    comments: [{ id: "c1", body: "why?", createdAt: "2024-01-01T00:00:00.000Z", anchor: anchor() }],
  });
  assert.equal(feedback.schema, FEEDBACK_SCHEMA);
  assert.equal(feedback.requestId, "req-1");
  assert.deepEqual(feedback.doc, { id: "d1", revision: 1 });
  assert.deepEqual(feedback.hunks[0], {
    id: "h1", decision: "accepted", base: "world", proposed: "there",
  });
  assert.equal(validateFeedback(feedback).ok, true);
});

test("validateFeedback rejects a payload that drifted from the schema", () => {
  const { envelope: parsed } = parseEnvelope(envelope());
  const feedback = buildFeedback({
    envelope: parsed,
    result: { format: "html", content: "x" },
    verdict: "accepted",
    hunks: [],
    comments: [],
  });
  assert.equal(validateFeedback(JSON.stringify(feedback)).ok, true);

  assert.equal(validateFeedback({ ...feedback, verdict: "maybe" }).ok, false);
  assert.equal(validateFeedback({ ...feedback, schema: "nope" }).ok, false);
  assert.equal(validateFeedback({ ...feedback, requestId: undefined }).ok, false);
  assert.equal(validateFeedback({ ...feedback, doc: { id: "d1", revision: 0 } }).ok, false);
  assert.equal(validateFeedback({ ...feedback, result: { format: "pdf", content: "x" } }).ok, false);
  assert.equal(validateFeedback({ ...feedback, hunks: [{ id: "h1", decision: "maybe" }] }).ok, false);
  assert.equal(validateFeedback({ ...feedback, comments: "no" }).ok, false);
  assert.equal(validateFeedback("{").ok, false);
});

test("validateFeedback validates the comment anchor shape", () => {
  const { envelope: parsed } = parseEnvelope(envelope());
  const base = buildFeedback({
    envelope: parsed,
    result: { format: "text", content: "x" },
    verdict: "accepted",
  });
  const withAnchor = (value) => ({ ...base, comments: [{ id: "c1", body: "b", createdAt: "t", anchor: value }] });

  assert.equal(validateFeedback(withAnchor(anchor())).ok, true);
  assert.equal(validateFeedback(withAnchor(anchor({ kind: "element", selector: "p", blockId: "b1" }))).ok, true);
  assert.equal(validateFeedback(withAnchor(anchor({ kind: "sideways" }))).ok, false);
  assert.equal(validateFeedback(withAnchor(anchor({ quote: "" }))).ok, false);
  assert.equal(validateFeedback(withAnchor(anchor({ offset: { start: 0 } }))).ok, false);
  assert.equal(validateFeedback(withAnchor(undefined)).ok, false);
  assert.equal(validateFeedback({ ...base, comments: [{ id: "c1", body: "b", createdAt: "t" }] }).ok, false);
});

test("ContractError exposes the individual errors", () => {
  const error = new ContractError([{ path: "$.doc", message: "bad" }]);
  assert.equal(error.name, "ContractError");
  assert.equal(error.message, "$.doc: bad");
  assert.deepEqual(error.errors, [{ path: "$.doc", message: "bad" }]);
});
