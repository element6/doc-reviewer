/**
 * Word-level diff core: writer-style bounded segments over token sequences.
 *
 * Pure and node-testable: no DOM, no I/O, no dependencies. Semantics mirror
 * writer/server.js `boundedWordDiff`, so both apps emit identical parts for
 * identical inputs (see architecture.md for the frozen contract).
 */

export const DIFF_WORK_LIMIT = 4_000_000;
export const MAX_DIFF_SEGMENTS = 4_096;
export const MAX_DIFF_TEXT_CHARS = 200_000;

export function wordTokens(value) {
  return value.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
}

/** Common prefix/suffix token counts, mirroring writer/server.js. */
function commonTokenBounds(left, right) {
  const limit = Math.min(left.length, right.length);
  let start = 0;
  while (start < limit && left[start] === right[start]) start += 1;
  let end = 0;
  while (end < limit - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end += 1;
  return { start, end };
}

export function diffSegments(base, proposed) {
  if (
    typeof base !== "string"
    || typeof proposed !== "string"
    || base.length > MAX_DIFF_TEXT_CHARS
    || proposed.length > MAX_DIFF_TEXT_CHARS
  ) {
    return { ok: false, reason: "too-long", parts: null };
  }
  if (base === proposed) {
    // Identical empty inputs have no non-empty segment to emit; the empty part
    // list is the only shape that never carries empty text.
    return { ok: true, parts: base.length === 0 ? [] : [{ type: "keep", text: base }] };
  }

  const left = wordTokens(base);
  const right = wordTokens(proposed);
  // Strip shared edges before budgeting: a one-token edit in a huge document
  // must cost only its own middle, never the whole table.
  const { start, end } = commonTokenBounds(left, right);
  const leftMiddle = left.slice(start, left.length - end);
  const rightMiddle = right.slice(start, right.length - end);

  // Bounds the LCS table by cell count before allocating it: the flat
  // Uint32Array below is (rows + 1) * (cols + 1) cells, at most 16 MB here.
  if ((leftMiddle.length + 1) * (rightMiddle.length + 1) > DIFF_WORK_LIMIT) {
    return { ok: false, reason: "work-limit", parts: null };
  }

  const parts = [];
  const push = (type, text) => {
    const last = parts.at(-1);
    if (last !== undefined && last.type === type) last.text += text;
    else parts.push({ type, text });
  };

  for (const token of left.slice(0, start)) push("keep", token);

  const stride = rightMiddle.length + 1;
  const table = new Uint32Array((leftMiddle.length + 1) * stride);
  for (let row = leftMiddle.length - 1; row >= 0; row -= 1) {
    for (let column = rightMiddle.length - 1; column >= 0; column -= 1) {
      table[row * stride + column] = leftMiddle[row] === rightMiddle[column]
        ? table[(row + 1) * stride + column + 1] + 1
        : Math.max(table[(row + 1) * stride + column], table[row * stride + column + 1]);
    }
  }

  let row = 0;
  let column = 0;
  while (row < leftMiddle.length && column < rightMiddle.length) {
    if (leftMiddle[row] === rightMiddle[column]) {
      push("keep", leftMiddle[row]);
      row += 1;
      column += 1;
    } else if (table[(row + 1) * stride + column] >= table[row * stride + column + 1]) {
      push("remove", leftMiddle[row]);
      row += 1;
    } else {
      push("add", rightMiddle[column]);
      column += 1;
    }
  }
  while (row < leftMiddle.length) {
    push("remove", leftMiddle[row]);
    row += 1;
  }
  while (column < rightMiddle.length) {
    push("add", rightMiddle[column]);
    column += 1;
  }

  for (const token of left.slice(left.length - end)) push("keep", token);

  if (parts.length > MAX_DIFF_SEGMENTS) {
    return { ok: false, reason: "too-long", parts: null };
  }
  return { ok: true, parts };
}

/** Mirrors writer/index.html:245 plus the part-shape rejections: non-array,
 * empty, over-cap part count, unknown type, non-string text, extra keys, and
 * aggregate length beyond base + proposed. Holds iff the non-`add` parts
 * reconstruct `base` and the non-`remove` parts reconstruct `proposed`. */
export function validDiff(base, proposed, parts) {
  if (typeof proposed !== "string" || proposed.length > MAX_DIFF_TEXT_CHARS) return false;
  if (!Array.isArray(parts) || !parts.length || parts.length > MAX_DIFF_SEGMENTS) return false;
  let original = "";
  let suggested = "";
  let aggregateLength = 0;
  for (const part of parts) {
    if (
      !part
      || typeof part !== "object"
      || Array.isArray(part)
      || Object.keys(part).length !== 2
      || typeof part.text !== "string"
      || !["keep", "remove", "add"].includes(part.type)
    ) return false;
    aggregateLength += part.text.length;
    if (aggregateLength > base.length + proposed.length) return false;
    if (part.type !== "add") original += part.text;
    if (part.type !== "remove") suggested += part.text;
  }
  return original === base && suggested === proposed;
}

export function hunksFromBlocks(baseBlocks, proposedBlocks) {
  if (!Array.isArray(baseBlocks) || !Array.isArray(proposedBlocks)) {
    return { ok: false, reason: "invalid-blocks" };
  }

  // Proposed index by block id, so an unchanged block can be located on both sides.
  const proposedIndexById = new Map();
  proposedBlocks.forEach((block, index) => {
    if (!proposedIndexById.has(block.blockId)) proposedIndexById.set(block.blockId, index);
  });

  // A block whose content-derived id exists on both sides is provably unchanged, so it
  // acts as an anchor and bounds the changed runs. Pairing by id alone is not enough:
  // a *modified* block gets a different id on each side, so it could never pair and
  // every prose edit degraded to an unrelated whole-block removed + added pair, with no
  // word-level inner diff at all.
  const anchors = [];
  let scan = 0;
  for (let index = 0; index < baseBlocks.length; index += 1) {
    const target = proposedIndexById.get(baseBlocks[index].blockId);
    if (target === undefined || target < scan) continue;
    anchors.push({ baseIndex: index, proposedIndex: target });
    scan = target + 1;
  }

  const baseEnd = baseBlocks.length > 0 ? baseBlocks[baseBlocks.length - 1].endOffset : 0;
  const hunks = [];

  // Within each run of changed blocks between two anchors, pair index by index so a
  // modified paragraph becomes ONE "changed" hunk carrying a word-level inner diff.
  // Whatever is left over on either side is a genuine deletion or insertion.
  const pairRuns = (baseRun, proposedRun, insertionOffset) => {
    const paired = Math.min(baseRun.length, proposedRun.length);
    for (let k = 0; k < paired; k += 1) {
      if (baseRun[k].html === proposedRun[k].html) continue;
      hunks.push(makeHunk("changed", baseRun[k], proposedRun[k], baseRun[k].offset));
    }
    for (let k = paired; k < baseRun.length; k += 1) {
      hunks.push(makeHunk("removed", baseRun[k], null, baseRun[k].offset));
    }
    for (let k = paired; k < proposedRun.length; k += 1) {
      hunks.push(makeHunk("added", null, proposedRun[k], insertionOffset));
    }
  };

  const boundaries = [
    { baseIndex: -1, proposedIndex: -1 },
    ...anchors,
    { baseIndex: baseBlocks.length, proposedIndex: proposedBlocks.length },
  ];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const from = boundaries[index];
    const to = boundaries[index + 1];
    const insertionOffset = to.baseIndex < baseBlocks.length ? baseBlocks[to.baseIndex].offset : baseEnd;
    pairRuns(
      baseBlocks.slice(from.baseIndex + 1, to.baseIndex),
      proposedBlocks.slice(from.proposedIndex + 1, to.proposedIndex),
      insertionOffset,
    );
  }

  hunks.sort(compareHunks);
  hunks.forEach((hunk, index) => {
    hunk.id = `h${index + 1}`;
  });
  return { ok: true, hunks };
}

function makeHunk(kind, baseBlock, proposedBlock, baseOffset) {
  const baseText = baseBlock === null ? "" : baseBlock.html;
  const proposedText = proposedBlock === null ? "" : proposedBlock.html;
  // A failed segment diff (too-long, work-limit) degrades to parts: null so
  // the UI can show a whole-block replacement instead of losing the hunk.
  const result = diffSegments(baseText, proposedText);
  return {
    kind,
    baseText,
    proposedText,
    parts: result.ok ? result.parts : null,
    baseBlockId: baseBlock === null ? null : baseBlock.blockId,
    proposedBlockId: proposedBlock === null ? null : proposedBlock.blockId,
    baseOffset,
  };
}

/** Ordering key: ascending baseOffset, insertions ahead of the block they
 * precede on a tie, otherwise stable so additions keep proposed order. */
function compareHunks(a, b) {
  if (a.baseOffset !== b.baseOffset) return a.baseOffset - b.baseOffset;
  if (a.kind === b.kind) return 0;
  return a.kind === "added" ? -1 : 1;
}
