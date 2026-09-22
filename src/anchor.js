/**
 * W3C Web Annotation text-quote anchors: build, relocate, staleness, display.
 *
 * Pure string operations so the module runs unchanged in the browser and under
 * `node --test`; converting DOM Ranges to offsets belongs to src/ui/selection.js.
 */

import { ANCHOR_CONTEXT_CHARS, MAX_QUOTE_CHARS } from "./contract.js";

/** Every start position of `quote` in `sourceText`, overlapping matches included. */
function findAll(sourceText, quote) {
  const positions = [];
  let from = 0;
  for (;;) {
    const index = sourceText.indexOf(quote, from);
    if (index === -1) return positions;
    positions.push(index);
    from = index + 1;
  }
}

export function anchorFromText({
  sourceText,
  start,
  end,
  blockId,
  selector,
  label,
  kind,
  quote: suppliedQuote,
}) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  // Empty ranges are rejected alongside inverted and out-of-range ones: feedback
  // validation requires a non-empty quote, so an anchor over "" could never be emitted.
  if (start < 0 || end > sourceText.length || start >= end) return null;
  const derived = typeof suppliedQuote !== "string";
  // A supplied quote is the caller's own text (an element's textContent, which may not
  // appear verbatim in the source because tags split it) and is honored as given; a
  // derived quote is the exact source slice. Both are capped at the contract's
  // MAX_QUOTE_CHARS so any anchor can be emitted in feedback. For a derived quote the
  // anchor covers only the truncated part, keeping offset and quote consistent for
  // locateAnchor's exact check and the suffix adjacent to the quote.
  const quote = (derived ? sourceText.slice(start, end) : suppliedQuote).slice(0, MAX_QUOTE_CHARS);
  if (quote.length === 0) return null;
  const offsetEnd = derived ? start + quote.length : end;
  const prefix = sourceText.slice(Math.max(0, start - ANCHOR_CONTEXT_CHARS), start);
  const suffix = sourceText.slice(offsetEnd, offsetEnd + ANCHOR_CONTEXT_CHARS);
  let occurrence = 0;
  for (const position of findAll(sourceText, quote)) {
    if (position >= start) break;
    occurrence += 1;
  }
  const anchor = {
    kind: kind === "text" || kind === "element" ? kind : selector ? "element" : "text",
    quote,
    prefix,
    suffix,
    occurrence,
    offset: { start, end: offsetEnd },
  };
  if (selector) anchor.selector = selector;
  if (blockId) anchor.blockId = blockId;
  if (label) anchor.label = label;
  return anchor;
}

/**
 * Re-find an anchor in text that may have shifted. The stored offset is checked first
 * because it is the cheapest proof; otherwise surrounding context is the strongest
 * remaining proof, and the occurrence index is only a positional guess.
 */
export function locateAnchor(sourceText, anchor) {
  const quote = anchor.quote;
  if (typeof quote !== "string" || quote.length === 0) {
    return { start: -1, end: -1, exact: false };
  }
  const offset = anchor.offset;
  if (
    offset && Number.isInteger(offset.start) && Number.isInteger(offset.end) &&
    sourceText.slice(offset.start, offset.end) === quote
  ) {
    return { start: offset.start, end: offset.end, exact: true };
  }
  const matches = findAll(sourceText, quote);
  if (matches.length === 0) return { start: -1, end: -1, exact: false };
  const prefix = typeof anchor.prefix === "string" ? anchor.prefix : "";
  const suffix = typeof anchor.suffix === "string" ? anchor.suffix : "";
  // With no stored context there is nothing that could confirm a position, so only a
  // stored prefix or suffix can upgrade a match to `exact`.
  if (prefix.length > 0 || suffix.length > 0) {
    for (const position of matches) {
      const before = sourceText.slice(Math.max(0, position - prefix.length), position);
      const after = sourceText.slice(
        position + quote.length,
        position + quote.length + suffix.length,
      );
      if (before === prefix && after === suffix) {
        return { start: position, end: position + quote.length, exact: true };
      }
    }
  }
  const occurrence =
    Number.isInteger(anchor.occurrence) && anchor.occurrence >= 0 ? anchor.occurrence : 0;
  const fallback = matches[Math.min(occurrence, matches.length - 1)];
  return { start: fallback, end: fallback + quote.length, exact: false };
}

export function isAnchorStale(sourceText, anchor) {
  return locateAnchor(sourceText, anchor).start === -1;
}

export function describeAnchor(anchor) {
  if (anchor.label) return `label: "${anchor.label}"`;
  const prefix = (anchor.prefix ?? "").trim();
  const suffix = (anchor.suffix ?? "").trim();
  const quote = (anchor.quote ?? "").trim();
  const before = prefix ? `...${prefix} ` : "";
  const after = suffix ? ` ${suffix}...` : "";
  return `${before}«${quote}»${after}`;
}
