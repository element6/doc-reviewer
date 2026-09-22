/**
 * Document surface: rendered mode shows one wrapper per source block stamped
 * data-dr-block so selectors resolve; source mode shows a monospace textarea
 * plus the hunk list. Block markup only enters the DOM via sanitizeHtml.
 */
import { extractBlocks } from "../html-blocks.js";
import { resultContent } from "../state.js";
import { renderHunks } from "./diff-view.js";

let mode = null;

export function setMode(next) {
  mode = next === "source" ? "source" : "rendered";
}

export function getMode() {
  return mode ?? "rendered";
}

export function defaultModeFor(format) {
  return format === "html" ? "rendered" : "source";
}

/**
 * Decisions are authoritative in `session.decisions`, keyed by hunk id (architecture.md).
 * A decision stored on the hunk itself is honoured as a fallback, so the view keeps
 * working if the session shape ever changes.
 */
function hunkDecisions(hunks, session) {
  const stored = session?.decisions;
  return new Map(
    hunks.map((hunk) => {
      const fromSession = stored instanceof Map ? stored.get(hunk.id) : stored?.[hunk.id];
      return [hunk.id, fromSession ?? hunk.decision ?? "unresolved"];
    }),
  );
}

function appendLegend(container) {
  const legend = document.createElement("div");
  legend.className = "review-legend";
  legend.setAttribute("aria-label", "Diff legend");
  const removed = document.createElement("span");
  removed.className = "legend-removed";
  removed.textContent = "Removed";
  const added = document.createElement("span");
  added.className = "legend-added";
  added.textContent = "Added";
  legend.append(removed, added);
  container.append(legend);
}

function makeBlockWrapper(block) {
  const wrapper = document.createElement("div");
  wrapper.className = "doc-block";
  wrapper.dataset.drBlock = block.blockId;
  return wrapper;
}

function fillPlainBlock(wrapper, block, format, sanitizeHtml) {
  if (format === "html") {
    // Sanitizer is the only path from untrusted markup to DOM (invariant 1).
    wrapper.innerHTML = sanitizeHtml(block.html);
  } else {
    // Markdown/text chunks are source text, not markup; show them verbatim.
    wrapper.textContent = block.html;
  }
}

/**
 * Pair hunks to blocks by exact source-slice match: hunksFromBlocks built each
 * hunk's baseText/proposedText by slicing these very blocks, so equality holds.
 */
function pairHunks(hunks, baseBlocks, propBlocks) {
  const usedBase = new Set();
  const usedProp = new Set();
  const byProp = new Map();
  const byBase = new Map();
  for (const hunk of hunks) {
    if (hunk.kind !== "removed") {
      const pb = propBlocks.find((b) => !usedProp.has(b) && b.html === hunk.proposedText);
      if (pb) {
        usedProp.add(pb);
        byProp.set(pb, hunk);
        if (hunk.kind === "changed") {
          const bb = baseBlocks.find((b) => !usedBase.has(b) && b.html === hunk.baseText);
          if (bb) {
            usedBase.add(bb);
            byBase.set(bb, hunk);
            hunk.__pairedBase = bb;
          }
        }
      }
    } else {
      const bb = baseBlocks.find((b) => !usedBase.has(b) && b.html === hunk.baseText);
      if (bb) {
        usedBase.add(bb);
        byBase.set(bb, hunk);
      }
    }
  }
  return { byProp, byBase };
}

function renderRendered({ session, container, sanitizeHtml, handlers, format, hunks, decisions }) {
  appendLegend(container);
  const baseBlocks = extractBlocks(session.envelope.doc.content, format);
  const propBlocks = extractBlocks(session.proposedContent, format);
  const { byProp, byBase } = pairHunks(hunks, baseBlocks, propBlocks);
  const baseIndex = new Map(baseBlocks.map((block, index) => [block, index]));
  const removedQueue = baseBlocks.filter((block) => {
    const hunk = byBase.get(block);
    return hunk && hunk.kind === "removed";
  });
  let removedCursor = 0;

  const emitRemovedBefore = (limitIndex) => {
    while (removedCursor < removedQueue.length && baseIndex.get(removedQueue[removedCursor]) < limitIndex) {
      const block = removedQueue[removedCursor];
      removedCursor += 1;
      const hunk = byBase.get(block);
      const decision = decisions.get(hunk.id) ?? "unresolved";
      if (decision === "accepted") continue; // removal agreed: text is gone
      if (decision === "rejected" || decision === "edited") {
        const wrapper = makeBlockWrapper(block);
        wrapper.classList.add("block-rejected");
        fillPlainBlock(wrapper, block, format, sanitizeHtml);
        container.append(wrapper);
        continue;
      }
      const wrapper = makeBlockWrapper(block);
      renderHunks([hunk], decisions, wrapper, handlers);
      container.append(wrapper);
    }
  };

  for (const block of propBlocks) {
    const hunk = byProp.get(block);
    if (!hunk) {
      const wrapper = makeBlockWrapper(block);
      fillPlainBlock(wrapper, block, format, sanitizeHtml);
      container.append(wrapper);
      continue;
    }
    const paired = hunk.__pairedBase;
    if (paired) emitRemovedBefore(baseIndex.get(paired));

    const decision = decisions.get(hunk.id) ?? "unresolved";
    if (hunk.kind === "added" && decision === "rejected") continue; // refusal: addition never lands
    const wrapper = makeBlockWrapper(block);
    if (decision === "accepted" || decision === "edited") {
      wrapper.classList.add("block-accepted");
      fillPlainBlock(wrapper, block, format, sanitizeHtml);
      container.append(wrapper);
    } else if (decision === "rejected") {
      // Reverted to the base side: find the paired base block content.
      const baseBlock = baseBlocks.find((b) => b.html === hunk.baseText);
      wrapper.classList.add("block-rejected");
      if (baseBlock) fillPlainBlock(wrapper, baseBlock, format, sanitizeHtml);
      else fillPlainBlock(wrapper, block, format, sanitizeHtml);
      container.append(wrapper);
    } else {
      renderHunks([hunk], decisions, wrapper, handlers);
      container.append(wrapper);
    }
  }
  emitRemovedBefore(Number.POSITIVE_INFINITY);
}

function renderSource({ session, container, handlers, format, hunks, decisions }) {
  const allowDirectEdit = session.envelope.options?.allowDirectEdit !== false;
  const textarea = document.createElement("textarea");
  textarea.className = "source-area";
  textarea.setAttribute("aria-label", "Document source");
  textarea.spellcheck = false;
  textarea.readOnly = !allowDirectEdit;
  textarea.value = resultContent(session);
  textarea.addEventListener("change", () => handlers.onSourceChange?.(textarea.value));
  container.append(textarea);

  if (!allowDirectEdit) {
    const note = document.createElement("p");
    note.className = "readonly-note";
    note.textContent = "Direct editing is disabled by the envelope (options.allowDirectEdit = false).";
    container.append(note);
  }

  if (hunks.length > 0) {
    appendLegend(container);
    const title = document.createElement("h3");
    title.className = "source-hunks-title";
    title.textContent = `Proposed changes (${hunks.length})`;
    const list = document.createElement("div");
    list.className = "hunk-list";
    renderHunks(hunks, decisions, list, handlers);
    container.append(title, list);
  }
}

export function renderDocument({ session, mode: explicitMode, container, sanitizeHtml, handlers = {} }) {
  if (!session) {
    container.replaceChildren();
    return;
  }
  const format = session.envelope.doc.format;
  const effective = explicitMode ?? mode ?? defaultModeFor(format);
  const hunks = session.hunks ?? [];
  const decisions = hunkDecisions(hunks, session);
  container.dataset.mode = effective;
  container.replaceChildren();
  const ctx = { session, container, sanitizeHtml, handlers, format, hunks, decisions };
  if (effective === "source") renderSource(ctx);
  else renderRendered(ctx);
}
