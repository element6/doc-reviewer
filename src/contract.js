/**
 * doc-reviewer contract: envelope@1 in, feedback@1 out.
 *
 * Zero-dependency validators, no DOM and no I/O, so this module runs unchanged in the
 * browser and under `node --test`. It is the interface spine: see architecture.md.
 */

export const ENVELOPE_SCHEMA = "doc-reviewer/envelope@1";
export const FEEDBACK_SCHEMA = "doc-reviewer/feedback@1";

export const FORMATS = ["html", "markdown", "text"];
export const FEEDBACK_VERDICTS = ["accepted", "rejected", "changes-requested"];
export const HUNK_DECISIONS = ["accepted", "rejected", "edited", "unresolved"];
export const OP_KINDS = ["replace", "delete", "insertAfter", "insertBefore"];

export const MAX_CONTENT_CHARS = 2_000_000;
export const MAX_TITLE_CHARS = 300;
export const MAX_SUMMARY_CHARS = 8_000;
export const MAX_RATIONALE_CHARS = 8_000;
export const MAX_COMMENT_CHARS = 8_000;
export const MAX_COMMENTS = 500;
export const MAX_OPS = 2_000;
export const MAX_QUOTE_CHARS = 4_000;
export const ANCHOR_CONTEXT_CHARS = 40;

const KNOWN_ENVELOPE_KEYS = new Set(["schema", "requestId", "doc", "proposal", "options"]);
const KNOWN_DOC_KEYS = new Set(["id", "title", "format", "revision", "content"]);
const KNOWN_PROPOSAL_KEYS = new Set(["kind", "content", "ops", "summary", "rationale"]);
const KNOWN_OPTION_KEYS = new Set(["allowDirectEdit", "diffGranularity"]);
const KNOWN_FEEDBACK_KEYS = new Set([
  "schema", "requestId", "doc", "verdict", "result", "hunks", "comments",
]);

export class ContractError extends Error {
  constructor(errors) {
    const list = Array.isArray(errors) ? errors : [{ path: "$", message: String(errors) }];
    super(list.map((entry) => `${entry.path}: ${entry.message}`).join("; "));
    this.name = "ContractError";
    this.errors = list;
  }
}

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value) => typeof value === "string";
const isNonEmptyString = (value) => isString(value) && value.length > 0;

function fail(errors, path, message) {
  errors.push({ path, message });
  return undefined;
}

function excerpt(value) {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

function reportUnknownKeys(raw, known, prefix, warnings) {
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) warnings.push(`ignored unknown field ${prefix}.${key}`);
  }
}

function expectString(raw, key, path, { max, nonEmpty = true }, errors) {
  const value = raw[key];
  if (value === undefined) return fail(errors, path, "required");
  if (!isString(value)) return fail(errors, path, "must be a string");
  if (nonEmpty && value.length === 0) return fail(errors, path, "must not be empty");
  if (max !== undefined && value.length > max) {
    return fail(errors, path, `must be at most ${max} characters`);
  }
  return value;
}

/** Bounded, non-empty, optionally length-capped string; `null` means invalid. */
function optionalString(raw, key, path, { max, nonEmpty = false }, errors) {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!isString(value)) return fail(errors, path, "must be a string");
  if (nonEmpty && value.length === 0) return fail(errors, path, "must not be empty");
  if (max !== undefined && value.length > max) {
    return fail(errors, path, `must be at most ${max} characters`);
  }
  return value;
}

function validateDoc(raw, errors, warnings) {
  const doc = {};
  doc.id = expectString(raw, "id", "$.doc.id", {}, errors);
  doc.title = expectString(raw, "title", "$.doc.title", { max: MAX_TITLE_CHARS }, errors);
  if (!FORMATS.includes(raw.format)) {
    doc.format = fail(errors, "$.doc.format", `must be one of ${FORMATS.map((f) => `"${f}"`).join(", ")}`);
  } else {
    doc.format = raw.format;
  }
  if (!Number.isInteger(raw.revision) || raw.revision < 1) {
    doc.revision = fail(errors, "$.doc.revision", "must be an integer >= 1");
  } else {
    doc.revision = raw.revision;
  }
  doc.content = expectString(raw, "content", "$.doc.content", { max: MAX_CONTENT_CHARS, nonEmpty: false }, errors);
  reportUnknownKeys(raw, KNOWN_DOC_KEYS, "$.doc", warnings);
  return doc;
}

function validateOp(raw, index, errors) {
  const path = `$.proposal.ops[${index}]`;
  if (!isPlainObject(raw)) return fail(errors, path, "must be an object");
  if (!OP_KINDS.includes(raw.op)) {
    return fail(errors, `${path}.op`, `must be one of ${OP_KINDS.map((k) => `"${k}"`).join(", ")}`);
  }
  const find = expectString(raw, "find", `${path}.find`, {}, errors);
  if (find === undefined) return undefined;
  const op = { op: raw.op, find };
  if (raw.op === "replace") {
    if (!isString(raw.replace)) return fail(errors, `${path}.replace`, 'required for op "replace"');
    op.replace = raw.replace;
  }
  if (raw.op === "insertAfter" || raw.op === "insertBefore") {
    if (!isString(raw.content)) return fail(errors, `${path}.content`, `required for op "${raw.op}"`);
    op.content = raw.content;
  }
  return op;
}

function validateProposal(raw, errors, warnings) {
  const proposal = {};
  if (!["replace", "patch"].includes(raw.kind)) {
    proposal.kind = fail(errors, "$.proposal.kind", 'must be "replace" or "patch"');
    return proposal;
  }
  proposal.kind = raw.kind;
  const summary = optionalString(raw, "summary", "$.proposal.summary", { max: MAX_SUMMARY_CHARS }, errors);
  if (summary !== undefined) proposal.summary = summary;
  const rationale = optionalString(raw, "rationale", "$.proposal.rationale", { max: MAX_RATIONALE_CHARS }, errors);
  if (rationale !== undefined) proposal.rationale = rationale;

  if (raw.kind === "replace") {
    proposal.content = expectString(
      raw, "content", "$.proposal.content",
      { max: MAX_CONTENT_CHARS, nonEmpty: false }, errors,
    );
  } else if (!Array.isArray(raw.ops) || raw.ops.length === 0) {
    proposal.ops = fail(errors, "$.proposal.ops", 'required, must be a non-empty array for kind "patch"');
  } else if (raw.ops.length > MAX_OPS) {
    proposal.ops = fail(errors, "$.proposal.ops", `must contain at most ${MAX_OPS} operations`);
  } else {
    const ops = raw.ops.map((op, index) => validateOp(op, index, errors));
    if (ops.every((op) => op !== undefined)) proposal.ops = ops;
  }
  reportUnknownKeys(raw, KNOWN_PROPOSAL_KEYS, "$.proposal", warnings);
  return proposal;
}

function validateOptions(raw, errors, warnings) {
  const options = { allowDirectEdit: true, diffGranularity: "auto" };
  if (raw === undefined) return options;
  if (!isPlainObject(raw)) {
    fail(errors, "$.options", "must be an object when present");
    return options;
  }
  if (raw.allowDirectEdit !== undefined) {
    if (typeof raw.allowDirectEdit !== "boolean") {
      fail(errors, "$.options.allowDirectEdit", "must be a boolean");
    } else {
      options.allowDirectEdit = raw.allowDirectEdit;
    }
  }
  if (raw.diffGranularity !== undefined) {
    if (!["auto", "block", "word"].includes(raw.diffGranularity)) {
      fail(errors, "$.options.diffGranularity", 'must be one of "auto", "block", "word"');
    } else {
      options.diffGranularity = raw.diffGranularity;
    }
  }
  reportUnknownKeys(raw, KNOWN_OPTION_KEYS, "$.options", warnings);
  return options;
}

/**
 * Parse and validate an envelope from a JSON string or an already-parsed object.
 * Never throws: a malformed envelope is a normal, reportable outcome.
 */
export function parseEnvelope(input) {
  const errors = [];
  const warnings = [];
  let raw = input;

  if (isString(input)) {
    try {
      raw = JSON.parse(input);
    } catch (error) {
      return { ok: false, errors: [{ path: "$", message: `not valid JSON: ${error.message}` }], warnings };
    }
  }
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ path: "$", message: "envelope must be a JSON object" }], warnings };
  }

  if (!isNonEmptyString(raw.schema)) {
    fail(errors, "$.schema", "required, must be a non-empty string");
  } else if (raw.schema !== ENVELOPE_SCHEMA) {
    const version = /^doc-reviewer\/envelope@(.+)$/.exec(raw.schema);
    fail(
      errors,
      "$.schema",
      version
        ? `unsupported envelope version "${version[1]}"; this build supports "${ENVELOPE_SCHEMA}"`
        : `unrecognized schema "${raw.schema}"; expected "${ENVELOPE_SCHEMA}"`,
    );
  }

  const requestId = expectString(raw, "requestId", "$.requestId", {}, errors);

  const doc = isPlainObject(raw.doc)
    ? validateDoc(raw.doc, errors, warnings)
    : (fail(errors, "$.doc", "required, must be an object"), undefined);
  const proposal = isPlainObject(raw.proposal)
    ? validateProposal(raw.proposal, errors, warnings)
    : (fail(errors, "$.proposal", "required, must be an object"), undefined);
  const options = validateOptions(raw.options, errors, warnings);

  reportUnknownKeys(raw, KNOWN_ENVELOPE_KEYS, "$", warnings);

  if (errors.length) return { ok: false, errors, warnings };
  return {
    ok: true,
    envelope: { schema: ENVELOPE_SCHEMA, requestId, doc, proposal, options },
    warnings,
  };
}

/**
 * Apply patch operations sequentially to raw source text. Each `find` must match
 * exactly once in the content as it stands when that op runs; anything else is
 * reported as an unresolved result rather than applied silently.
 */
export function resolvePatch(base, ops) {
  const results = [];
  let content = base;

  ops.forEach((op, index) => {
    const record = { index, status: "applied" };
    const first = content.indexOf(op.find);
    if (first === -1) {
      record.status = "not-found";
      record.reason = `find text not present: "${excerpt(op.find)}"`;
      results.push(record);
      return;
    }
    if (content.indexOf(op.find, first + 1) !== -1) {
      record.status = "ambiguous";
      record.reason = `find text matches more than once: "${excerpt(op.find)}"`;
      results.push(record);
      return;
    }
    const end = first + op.find.length;
    if (op.op === "replace") {
      content = content.slice(0, first) + op.replace + content.slice(end);
    } else if (op.op === "delete") {
      content = content.slice(0, first) + content.slice(end);
    } else if (op.op === "insertAfter") {
      content = content.slice(0, end) + op.content + content.slice(end);
    } else if (op.op === "insertBefore") {
      content = content.slice(0, first) + op.content + content.slice(first);
    } else {
      record.status = "invalid";
      record.reason = `unknown op "${op.op}"`;
    }
    results.push(record);
  });

  return { content, results };
}

/** Resolve an envelope's proposal into proposed document text. */
export function applyProposal(doc, proposal) {
  if (proposal.kind === "replace") return { content: proposal.content, opResults: [] };
  const { content, results } = resolvePatch(doc.content, proposal.ops ?? []);
  return { content, opResults: results };
}

function validateAnchor(raw, path, errors) {
  if (!isPlainObject(raw)) return fail(errors, path, "must be an object");
  if (!["text", "element"].includes(raw.kind)) {
    fail(errors, `${path}.kind`, 'must be "text" or "element"');
  }
  const quote = expectString(raw, "quote", `${path}.quote`, { max: MAX_QUOTE_CHARS }, errors);
  if (quote === undefined) return undefined;
  const anchor = {
    kind: raw.kind,
    quote,
    prefix: isString(raw.prefix) ? raw.prefix : "",
    suffix: isString(raw.suffix) ? raw.suffix : "",
    occurrence: Number.isInteger(raw.occurrence) && raw.occurrence >= 0 ? raw.occurrence : 0,
  };
  if (!isPlainObject(raw.offset) || !Number.isInteger(raw.offset.start) || !Number.isInteger(raw.offset.end)) {
    fail(errors, `${path}.offset`, "must be an object with integer start and end");
  } else {
    anchor.offset = { start: raw.offset.start, end: raw.offset.end };
  }
  if (isString(raw.selector)) anchor.selector = raw.selector;
  if (isString(raw.blockId)) anchor.blockId = raw.blockId;
  if (isString(raw.label)) anchor.label = raw.label;
  return anchor;
}

/** Assemble a feedback payload. Callers may pass `validateFeedback` over the result. */
export function buildFeedback({ envelope, result, verdict, hunks = [], comments = [] }) {
  return {
    schema: FEEDBACK_SCHEMA,
    requestId: envelope.requestId,
    doc: { id: envelope.doc.id, revision: envelope.doc.revision },
    verdict,
    result: { format: result.format, content: result.content },
    hunks: hunks.map((hunk) => ({
      id: hunk.id,
      decision: hunk.decision,
      base: hunk.baseText,
      proposed: hunk.proposedText,
    })),
    comments: comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      anchor: comment.anchor,
    })),
  };
}

/** Validate a feedback payload, e.g. before handing it back to an AI. */
export function validateFeedback(input) {
  const errors = [];
  let raw = input;
  if (isString(input)) {
    try {
      raw = JSON.parse(input);
    } catch (error) {
      return { ok: false, errors: [{ path: "$", message: `not valid JSON: ${error.message}` }] };
    }
  }
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ path: "$", message: "feedback must be a JSON object" }] };
  }
  if (raw.schema !== FEEDBACK_SCHEMA) {
    fail(errors, "$.schema", `must be "${FEEDBACK_SCHEMA}"`);
  }
  expectString(raw, "requestId", "$.requestId", {}, errors);
  if (!isPlainObject(raw.doc)) {
    fail(errors, "$.doc", "required, must be an object");
  } else {
    expectString(raw.doc, "id", "$.doc.id", {}, errors);
    if (!Number.isInteger(raw.doc.revision) || raw.doc.revision < 1) {
      fail(errors, "$.doc.revision", "must be an integer >= 1");
    }
  }
  if (!FEEDBACK_VERDICTS.includes(raw.verdict)) {
    fail(errors, "$.verdict", `must be one of ${FEEDBACK_VERDICTS.map((v) => `"${v}"`).join(", ")}`);
  }
  if (!isPlainObject(raw.result)) {
    fail(errors, "$.result", "required, must be an object");
  } else {
    if (!FORMATS.includes(raw.result.format)) {
      fail(errors, "$.result.format", `must be one of ${FORMATS.map((f) => `"${f}"`).join(", ")}`);
    }
    if (!isString(raw.result.content)) fail(errors, "$.result.content", "must be a string");
  }
  if (!Array.isArray(raw.hunks)) {
    fail(errors, "$.hunks", "required, must be an array");
  } else {
    raw.hunks.forEach((hunk, index) => {
      const path = `$.hunks[${index}]`;
      if (!isPlainObject(hunk)) return fail(errors, path, "must be an object");
      expectString(hunk, "id", `${path}.id`, {}, errors);
      if (!HUNK_DECISIONS.includes(hunk.decision)) {
        fail(errors, `${path}.decision`, `must be one of ${HUNK_DECISIONS.map((d) => `"${d}"`).join(", ")}`);
      }
      if (!isString(hunk.base)) fail(errors, `${path}.base`, "must be a string");
      if (!isString(hunk.proposed)) fail(errors, `${path}.proposed`, "must be a string");
      return undefined;
    });
  }
  if (!Array.isArray(raw.comments)) {
    fail(errors, "$.comments", "required, must be an array");
  } else if (raw.comments.length > MAX_COMMENTS) {
    fail(errors, "$.comments", `must contain at most ${MAX_COMMENTS} comments`);
  } else {
    raw.comments.forEach((comment, index) => {
      const path = `$.comments[${index}]`;
      if (!isPlainObject(comment)) return fail(errors, path, "must be an object");
      expectString(comment, "id", `${path}.id`, {}, errors);
      expectString(comment, "body", `${path}.body`, { max: MAX_COMMENT_CHARS }, errors);
      expectString(comment, "createdAt", `${path}.createdAt`, {}, errors);
      validateAnchor(comment.anchor, `${path}.anchor`, errors);
      return undefined;
    });
  }
  reportUnknownKeys(raw, KNOWN_FEEDBACK_KEYS, "$", []);

  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}
