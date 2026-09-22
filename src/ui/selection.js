/**
 * DOM-to-source glue: converts a live selection or a picked element into an
 * anchor by computing character offsets into the document source (never into
 * the rendered DOM), then handing them to anchorFromText. Offsets are derived
 * per block: extractBlocks partitions the source, so accumulating block html
 * lengths gives each block's exact source span.
 */
import { anchorFromText } from "../anchor.js";

function elementWithin(node, root) {
  let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (el && el !== root) {
    if (el.dataset?.drBlock) return el;
    el = el.parentElement;
  }
  return root.contains(el) && root !== el && root.dataset?.drBlock ? root : el === root ? null : null;
}

function blockSpan(blocks) {
  const spans = [];
  let start = 0;
  for (const block of blocks) {
    spans.push({ start, end: start + block.html.length });
    start += block.html.length;
  }
  return spans;
}

const ENTITY = /&(amp|lt|gt|quot|#39|nbsp);|&#(\d+);/g;
const NAMED_ENTITY_LENGTHS = { amp: 1, lt: 1, gt: 1, quot: 1, "#39": 1, nbsp: 1 };

/**
 * Map an offset in the block's visible text (tags stripped, entities decoded)
 * to an offset within the raw source html of that block.
 */
function textToSourceOffset(html, textOffset) {
  let textCount = 0;
  let index = 0;
  let inTag = false;
  while (index < html.length) {
    if (textCount >= textOffset) return index;
    const char = html[index];
    if (char === "<") {
      inTag = true;
      index += 1;
      continue;
    }
    if (char === ">" && inTag) {
      inTag = false;
      index += 1;
      continue;
    }
    if (inTag) {
      index += 1;
      continue;
    }
    if (char === "&") {
      ENTITY.lastIndex = 0;
      const rest = html.slice(index, index + 12);
      const match = ENTITY.exec(rest);
      if (match && match.index === 0) {
        const decoded = match[2] !== undefined ? String.fromCodePoint(Number(match[2])) : match[1];
        textCount += decoded.length;
        index += match[0].length;
        continue;
      }
    }
    textCount += 1;
    index += 1;
  }
  return html.length;
}

function preLength(range) {
  // Text length of everything in the block before the selection start.
  const blockEl = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer
    : range.startContainer.parentElement?.closest("[data-dr-block]");
  if (!blockEl) return 0;
  const pre = document.createRange();
  pre.selectNodeContents(blockEl);
  try {
    pre.setEnd(range.startContainer, range.startOffset);
  } catch {
    return 0;
  }
  return pre.toString().length;
}

function selectorPath(element, root) {
  const parts = [];
  let el = element;
  while (el && el !== root) {
    if (el.id) {
      parts.unshift(`#${el.id}`);
      break;
    }
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent) break;
    const sameTag = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
    const nth = sameTag.indexOf(el) + 1;
    parts.unshift(sameTag.length > 1 || parent !== root ? `${tag}:nth-of-type(${nth})` : tag);
    el = parent;
  }
  const scope = root.id ? `#${root.id}` : "";
  return parts.length ? `${scope} > ${parts.join(" > ")}`.replace(/^# > /, "") : "";
}

function locateInSource(context, blockEl, quote, guessTextOffset) {
  const blockId = blockEl.dataset.drBlock;
  const { format } = context;
  const candidates = [];
  // Prefer the proposed source (the rendered spine), then the base source
  // (removed text, reverted blocks) — whichever contains the block id.
  const propIndex = context.propBlocks.findIndex((b) => b.blockId === blockId);
  if (propIndex >= 0) candidates.push({ sourceText: context.proposedText, blocks: context.propBlocks, index: propIndex });
  const baseIndex = context.baseBlocks.findIndex((b) => b.blockId === blockId);
  if (baseIndex >= 0) candidates.push({ sourceText: context.baseText, blocks: context.baseBlocks, index: baseIndex });
  if (candidates.length === 0 && format) candidates.push({ sourceText: context.proposedText, blocks: context.propBlocks, index: -1 });

  for (const candidate of candidates) {
    if (candidate.index < 0) continue;
    const html = candidate.blocks[candidate.index].html;
    const spanStart = blockSpan(candidate.blocks)[candidate.index].start;
    const guess = spanStart + textToSourceOffset(html, guessTextOffset);
    // Prefer the occurrence of the quote closest to the mapped guess.
    let best = -1;
    let from = 0;
    let found;
    while ((found = candidate.sourceText.indexOf(quote, from)) !== -1 && found < spanStart + html.length) {
      if (found < spanStart) {
        from = found + 1;
        continue;
      }
      if (best === -1 || Math.abs(found - guess) < Math.abs(best - guess)) best = found;
      from = found + 1;
      if (from > spanStart + html.length) break;
    }
    if (best >= 0) return { sourceText: candidate.sourceText, start: best, end: best + quote.length, blockIndex: candidate.index };
    // Quote spans tags or sanitizer-normalized text: fall back to offsets.
    const guessRel = textToSourceOffset(html, guessTextOffset);
    const start = spanStart + guessRel;
    return {
      sourceText: candidate.sourceText,
      start,
      end: Math.min(spanStart + html.length, start + quote.length),
      blockIndex: candidate.index,
    };
  }
  return null;
}

/**
 * Convert a DOM Range into an anchor, or null when it cannot be mapped
 * (collapsed, outside the document surface, or in an unknown block).
 */
export function anchorFromRange(range, context) {
  if (!range || range.collapsed || !context) return null;
  const root = context.root;
  const quote = range.toString();
  if (!quote) return null;
  const blockEl = elementWithin(range.startContainer, root);
  if (!blockEl || !blockEl.dataset?.drBlock) return null;
  const guess = preLength(range);
  const located = locateInSource(context, blockEl, quote, guess);
  if (!located) return null;
  const owner = blockEl.firstElementChild ?? blockEl;
  const label = `${owner.tagName.toLowerCase()} in block ${blockEl.dataset.drBlock}`;
  return anchorFromText({
    sourceText: located.sourceText,
    start: located.start,
    end: located.end,
    blockId: blockEl.dataset.drBlock,
    label,
  });
}

/** Build an element anchor from a picked element (or a block wrapper). */
export function anchorFromElement(element, context) {
  if (!element || !context) return null;
  const root = context.root;
  const blockEl = element.closest?.("[data-dr-block]") ?? null;
  if (!blockEl) return null;
  const text = element.textContent ?? "";
  const pre = document.createRange();
  pre.selectNodeContents(blockEl);
  let textStart = 0;
  try {
    pre.setEnd(element, 0);
    textStart = pre.toString().length;
  } catch {
    textStart = 0;
  }
  const located = locateInSource(context, blockEl, text.slice(0, 64), textStart);
  if (!located) return null;
  return anchorFromText({
    sourceText: located.sourceText,
    start: located.start,
    end: Math.min(located.start + text.length, located.sourceText.length),
    blockId: blockEl.dataset.drBlock,
    selector: selectorPath(element, root),
    label: `${element.tagName.toLowerCase()} in block ${blockEl.dataset.drBlock}`,
    kind: "element",
    quote: text,
  });
}

/**
 * Element picker: hover highlights the candidate, click picks it, Escape
 * cancels. Returns a stop function that removes every listener.
 */
export function startElementPicker({ root, context, onPick, onCancel }) {
  let hovered = null;
  const clearHover = () => {
    hovered?.classList.remove("pick-target");
    hovered = null;
  };
  const onMouseOver = (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-dr-block], [data-dr-block] *") : null;
    const candidate = target && root.contains(target) ? target : null;
    if (candidate === hovered) return;
    clearHover();
    if (candidate) {
      hovered = candidate;
      candidate.classList.add("pick-target");
    }
  };
  const onClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !root.contains(target)) return;
    const element = target.closest("[data-dr-block]") ?? target;
    const rect = element.getBoundingClientRect();
    const anchor = anchorFromElement(element, context);
    stop();
    if (anchor) onPick?.(anchor, rect);
    else onCancel?.("Could not map that element to document source.");
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      stop();
      onCancel?.(null);
    }
  };
  const stop = () => {
    clearHover();
    root.removeEventListener("mouseover", onMouseOver, true);
    root.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKeyDown, true);
  };
  root.addEventListener("mouseover", onMouseOver, true);
  root.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeyDown, true);
  return stop;
}
