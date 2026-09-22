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
  resolvePatch,
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
    proposal: { kind: "patch", ops: [{ op: "replace", find: "world", replace: "there" }] },
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
  assert.deepEqual(fromString.envelope.options, { allowDirectEdit: true, diffGranularity: "auto" });
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
  const result = parseEnvelope(envelope({ extra: true, doc: { ...DOC, mood: "calm" } }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, [
    "ignored unknown field $.doc.mood",
    "ignored unknown field $.extra",
  ]);
});

test("parseEnvelope collects every field error at once", () => {
  const result = parseEnvelope({
    schema: ENVELOPE_SCHEMA,
    requestId: "",
    doc: { id: "d1", title: "x".repeat(MAX_TITLE_CHARS + 1), format: "pdf", revision: 0, content: 7 },
    proposal: { kind: "patch", ops: [] },
    options: { diffGranularity: "line" },
  });
  assert.equal(result.ok, false);
  const paths = result.errors.map((error) => error.path).sort();
  assert.deepEqual(paths, [
    "$.doc.content",
    "$.doc.format",
    "$.doc.revision",
    "$.doc.title",
    "$.options.diffGranularity",
    "$.proposal.ops",
    "$.requestId",
  ]);
});

test("parseEnvelope requires the field each proposal kind needs", () => {
  const noContent = parseEnvelope(envelope({ proposal: { kind: "replace" } }));
  assert.equal(noContent.ok, false);
  assert.equal(noContent.errors[0].path, "$.proposal.content");

  const noOps = parseEnvelope(envelope({ proposal: { kind: "patch" } }));
  assert.equal(noOps.ok, false);
  assert.equal(noOps.errors[0].path, "$.proposal.ops");

  const emptyOps = parseEnvelope(envelope({ proposal: { kind: "patch", ops: [] } }));
  assert.equal(emptyOps.ok, false);

  const badOp = parseEnvelope(envelope({ proposal: { kind: "patch", ops: [{ op: "swap", find: "a" }] } }));
  assert.equal(badOp.ok, false);
  assert.equal(badOp.errors[0].path, "$.proposal.ops[0].op");

  const missingReplace = parseEnvelope(envelope({ proposal: { kind: "patch", ops: [{ op: "replace", find: "a" }] } }));
  assert.equal(missingReplace.ok, false);
  assert.equal(missingReplace.errors[0].path, "$.proposal.ops[0].replace");
});

test("an empty document content is valid", () => {
  const result = parseEnvelope(envelope({ doc: { ...DOC, content: "" } }));
  assert.equal(result.ok, true);
  assert.equal(result.envelope.doc.content, "");
});

test("resolvePatch applies each operation sequentially", () => {
  const { content, results } = resolvePatch("alpha beta", [
    { op: "replace", find: "beta", replace: "gamma" },
    { op: "insertAfter", find: "gamma", content: "!" },
  ]);
  assert.equal(content, "alpha gamma!");
  assert.deepEqual(results.map((entry) => entry.status), ["applied", "applied"]);
});

test("resolvePatch implements every operation kind", () => {
  assert.equal(resolvePatch("abc", [{ op: "delete", find: "b" }]).content, "ac");
  assert.equal(resolvePatch("abc", [{ op: "insertBefore", find: "b", content: "X" }]).content, "aXbc");
  assert.equal(resolvePatch("abc", [{ op: "insertAfter", find: "b", content: "X" }]).content, "abXc");
  assert.equal(resolvePatch("abc", [{ op: "replace", find: "b", replace: "X" }]).content, "aXc");
});

test("resolvePatch refuses absent and ambiguous finds rather than guessing", () => {
  const absent = resolvePatch("abc", [{ op: "delete", find: "zz" }]);
  assert.equal(absent.content, "abc");
  assert.equal(absent.results[0].status, "not-found");
  assert.match(absent.results[0].reason, /not present/);

  const ambiguous = resolvePatch("x x", [{ op: "delete", find: "x" }]);
  assert.equal(ambiguous.content, "x x");
  assert.equal(ambiguous.results[0].status, "ambiguous");
  assert.match(ambiguous.results[0].reason, /more than once/);
});

test("resolvePatch keeps going after an unresolved op and reports each result", () => {
  const { content, results } = resolvePatch("one two", [
    { op: "delete", find: "missing" },
    { op: "delete", find: "one " },
  ]);
  assert.equal(content, "two");
  assert.deepEqual(results.map((entry) => entry.status), ["not-found", "applied"]);
  assert.deepEqual(results.map((entry) => entry.index), [0, 1]);
});

test("applyProposal short-circuits a full replacement", () => {
  const replaced = applyProposal({ content: "old" }, { kind: "replace", content: "new" });
  assert.deepEqual(replaced, { content: "new", opResults: [] });
  const patched = applyProposal({ content: "old" }, { kind: "patch", ops: [{ op: "delete", find: "old" }] });
  assert.equal(patched.content, "");
  assert.equal(patched.opResults.length, 1);
});

test("a long find string is truncated in the reported reason", () => {
  const long = "z".repeat(200);
  const { results } = resolvePatch("abc", [{ op: "delete", find: long }]);
  assert.ok(results[0].reason.length < 100);
  assert.match(results[0].reason, /\.\.\./);
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
