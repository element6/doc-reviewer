/**
 * Session bookkeeping over an already-computed hunk list: decisions, manual edits,
 * comments, undo/redo, and the splice that turns decisions back into a document.
 *
 * Imports only the contract so the module runs unchanged in the browser and under
 * `node --test`; wiring diff.js and html-blocks.js together is main.js's job.
 */

import { HUNK_DECISIONS, buildFeedback } from "./contract.js";

const STACK_CAP = 100;

/** Drop the history fields so a snapshot can sit on the stack without nesting stacks. */
function snapshot(session) {
  const { past, future, ...state } = session;
  return state;
}

/** Single entry point for mutations: previous state onto past (capped), future cleared. */
function revise(session, patch) {
  const past = [...session.past, snapshot(session)];
  if (past.length > STACK_CAP) past.splice(0, past.length - STACK_CAP);
  return { ...session, ...patch, past, future: [] };
}

/**
 * A request that cannot be honoured records why and changes nothing else: throwing
 * would take the UI down over a stale click, and staying silent would hide the mistake.
 */
function warnOnly(session, message) {
  return { ...session, warnings: [...session.warnings, message] };
}

export function createSession({ envelope, proposedContent, hunks, baseBlocks = [], opResults = [] }) {
  const decisions = {};
  for (const hunk of hunks) decisions[hunk.id] = "unresolved";
  return {
    envelope,
    baseContent: envelope.doc.content,
    proposedContent,
    opResults,
    hunks,
    baseBlocks,
    override: null,
    decisions,
    edits: {},
    comments: [],
    warnings: [],
    past: [],
    future: [],
  };
}

export function decide(session, hunkId, decision) {
  if (!Object.hasOwn(session.decisions, hunkId)) {
    return warnOnly(session, `unknown hunk "${hunkId}"`);
  }
  if (!HUNK_DECISIONS.includes(decision)) {
    return warnOnly(session, `invalid decision "${decision}"`);
  }
  // Any hunk-level mutation ends source mode: a stale whole-document rewrite must not
  // silently shadow a fresh decision (see setDocumentOverride).
  return revise(session, {
    decisions: { ...session.decisions, [hunkId]: decision },
    override: null,
  });
}

export function decideAll(session, decision) {
  if (!HUNK_DECISIONS.includes(decision)) {
    return warnOnly(session, `invalid decision "${decision}"`);
  }
  const decisions = { ...session.decisions };
  for (const hunk of session.hunks) {
    // "edited" is set by setManualEdit, never by bulk decisions: overwriting it would
    // silently discard the hand-written text the user just entered.
    if (decisions[hunk.id] !== "edited") decisions[hunk.id] = decision;
  }
  return revise(session, { decisions, override: null });
}

export function setManualEdit(session, blockId, html) {
  // Every path through this function also ends source mode (override cleared), because
  // a hand edit is a hunk-level statement about the document.
  const edits = { ...session.edits, [blockId]: html };
  // The link from an edit to its hunks is structural, never textual: a hand edit differs
  // from proposedText by definition, so comparing text can never fire. Hunks carry the
  // ids of the blocks on both sides, so either side identifies every hunk the block
  // feeds.
  const covered = session.hunks.filter(
    (hunk) => hunk.baseBlockId === blockId || hunk.proposedBlockId === blockId,
  );
  if (covered.length > 0) {
    const decisions = { ...session.decisions };
    for (const hunk of covered) decisions[hunk.id] = "edited";
    return revise(session, { edits, decisions, override: null });
  }
  // A block no hunk covers (an unchanged block the user still rewrote). Splicing needs
  // a base offset that only the block partition knows, so synthesise a hunk spanning
  // the block's original text on both sides; with decision "edited" the splice then
  // takes edits[blockId] in its place. The synthetic hunk also rides into feedback: a
  // hand edit is information the AI must receive.
  const block = session.baseBlocks.find(
    (candidate) => candidate.blockId === blockId && Number.isInteger(candidate.offset),
  );
  if (!block) {
    return revise(session, {
      edits,
      override: null,
      warnings: [
        ...session.warnings,
        `edit for block "${blockId}": no matching hunk or base block`,
      ],
    });
  }
  const hunk = {
    id: `edit:${blockId}`,
    kind: "changed",
    baseText: block.html,
    proposedText: block.html,
    parts: [],
    baseOffset: block.offset,
    baseBlockId: block.blockId,
    proposedBlockId: block.blockId,
  };
  return revise(session, {
    edits,
    hunks: [...session.hunks, hunk],
    decisions: { ...session.decisions, [hunk.id]: "edited" },
    override: null,
  });
}

/**
 * Whole-document override for the UI's source-mode editor. While it is set the human
 * owns the text: resultContent returns it verbatim and every hunk is marked "edited"
 * because the hunk list no longer describes the document. Clearing (null) only removes
 * the override and leaves decisions alone. Any later hunk-level mutation clears the
 * override instead of letting a stale rewrite shadow new decisions — exactly one
 * source of truth at a time; undo is how the override comes back.
 */
export function setDocumentOverride(session, content) {
  if (content == null) return revise(session, { override: null });
  const decisions = { ...session.decisions };
  for (const hunk of session.hunks) decisions[hunk.id] = "edited";
  return revise(session, { override: content, decisions });
}

export function addComment(session, anchor, body) {
  // Derive the next id from the ids still present so removal never renumbers the
  // comments that remain; payloads stay internally unique even after a removal.
  let highest = 0;
  for (const comment of session.comments) {
    const suffix = Number.parseInt(comment.id.slice(1), 10);
    if (Number.isInteger(suffix) && suffix > highest) highest = suffix;
  }
  const comment = { id: `c${highest + 1}`, body, createdAt: new Date().toISOString(), anchor };
  return revise(session, { comments: [...session.comments, comment] });
}

export function removeComment(session, commentId) {
  if (!session.comments.some((comment) => comment.id === commentId)) {
    return warnOnly(session, `comment "${commentId}" not found`);
  }
  return revise(session, {
    comments: session.comments.filter((comment) => comment.id !== commentId),
  });
}

const byDocumentOrder = (a, b) =>
  a.baseOffset - b.baseOffset ||
  (a.kind === "added" ? 0 : 1) - (b.kind === "added" ? 0 : 1);

/**
 * resultContent's frozen signature returns only a string, so splice diagnostics land on
 * the session in place. The array is replaced rather than mutated, so the snapshots on
 * the undo stack keep their own copy. Consecutive duplicates collapse because render
 * loops call this function repeatedly over the same broken state.
 */
function note(session, message) {
  if (session.warnings[session.warnings.length - 1] === message) return;
  session.warnings = [...session.warnings, message];
}

/**
 * Walk the hunks in document order with a cursor into the base document and splice each
 * chosen side in verbatim. Text is never searched for: baseOffset is the address, and a
 * slice that no longer matches its address is skipped with a warning rather than
 * guessed at, because guessing would corrupt the round-trip invariants.
 */
export function resultContent(session) {
  // Source mode: the override is the whole document, so hunk composition is ignored
  // until the override is cleared.
  if (session.override != null) return session.override;
  const base = session.baseContent;
  const sorted = [...session.hunks].sort(byDocumentOrder);
  let cursor = 0;
  let out = "";
  for (const hunk of sorted) {
    const offset = hunk.baseOffset;
    if (!Number.isInteger(offset) || offset < 0) {
      note(session, `hunk "${hunk.id}": invalid base offset; skipped`);
      continue;
    }
    if (hunk.kind !== "added" && base.slice(offset, offset + hunk.baseText.length) !== hunk.baseText) {
      note(session, `hunk "${hunk.id}": base text not found; skipped`);
      continue;
    }
    out += base.slice(cursor, offset);
    cursor = offset;
    const decision = session.decisions[hunk.id] ?? "unresolved";
    const takeProposed = decision === "accepted" || decision === "edited";
    if (hunk.kind === "added") {
      // An inserted hunk consumes no base text: the cursor stays at the insertion point
      // so the region is still owned by the surrounding base slices.
      if (takeProposed) out += session.edits[hunk.proposedBlockId] ?? hunk.proposedText;
      continue;
    }
    // The decision selects a side, and a manual edit recorded for that side wins over
    // the hunk's own text.
    const side = takeProposed ? hunk.proposedBlockId : hunk.baseBlockId;
    out += session.edits[side] ?? (takeProposed ? hunk.proposedText : hunk.baseText);
    cursor = offset + hunk.baseText.length;
  }
  out += base.slice(cursor);
  return out;
}

export function undo(session) {
  if (session.past.length === 0) return { ...session };
  const previous = session.past[session.past.length - 1];
  return {
    ...previous,
    past: session.past.slice(0, -1),
    future: [snapshot(session), ...session.future],
  };
}

export function redo(session) {
  if (session.future.length === 0) return { ...session };
  const [next, ...rest] = session.future;
  const past = [...session.past, snapshot(session)];
  if (past.length > STACK_CAP) past.splice(0, past.length - STACK_CAP);
  return { ...next, past, future: rest };
}

function verdictFor(session) {
  const decisionOf = (hunk) => session.decisions[hunk.id] ?? "unresolved";
  if (session.hunks.every((hunk) => {
    const decision = decisionOf(hunk);
    return decision === "accepted" || decision === "edited";
  })) {
    return "accepted";
  }
  if (session.hunks.every((hunk) => decisionOf(hunk) === "rejected")) {
    return "rejected";
  }
  return "changes-requested";
}

export function buildFeedbackPayload(session) {
  return buildFeedback({
    envelope: session.envelope,
    result: { format: session.envelope.doc.format, content: resultContent(session) },
    verdict: verdictFor(session),
    hunks: session.hunks.map((hunk) => ({
      ...hunk,
      decision: session.decisions[hunk.id] ?? "unresolved",
    })),
    comments: session.comments,
  });
}
