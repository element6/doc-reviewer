/**
 * Block extraction over raw source text: a tolerant HTML tag scanner plus a
 * blank-line chunker. No DOM, so the module runs unchanged in the browser and
 * under `node --test` (see architecture.md); DOM construction lives in `ui/`.
 *
 * Every extractor partitions its input: concatenating the returned `html`
 * slices in order reproduces `content` byte-for-byte. `state.js` splices these
 * exact slices back together, so any gap would silently corrupt round-tripping.
 */

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr",
]);

// Raw-text element bodies are markup-like data: scanning them for tags would
// split a block on strings that merely look like tags (`"<div>"` in a script).
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);

// script and style bodies are never rendered as page text; keeping them would
// poison block labels and word diffs with CSS and JavaScript source.
const INVISIBLE_TEXT_ELEMENTS = new Set(["script", "style"]);

const TAG_NAME = /[a-zA-Z][^\s/>]*/y;
const CHUNK_SEPARATOR = /(\r?\n\s*\r?\n)+/g;
const LEADING_SPACE = /^\s+/;
const WHITESPACE = /\s+/g;

/** Insignificant-source normalizer: ids should survive tag case and whitespace
 * runs so pairing keys on rendered-equivalent content, not formatting. */
export function normalizeHtml(html) {
  // Collapse whitespace runs, since browsers collapse them anyway and the partition
  // attaches trailing whitespace to the preceding block. Case-fold MARKUP ONLY: folding
  // the whole string made "alpha" and "Alpha" hash identically, so a case-only edit paired
  // as an unchanged anchor and stayed invisible in the diff.
  return html
    .replace(WHITESPACE, " ")
    .trim()
    .replace(/<[^>]*>/g, (tag) => tag.toLowerCase());
}

/** FNV-1a 32-bit over the normalized string, bytes taken from UTF-16 code
 * units (low byte first) so the hash is deterministic without crypto or DOM. */
export function blockKey(html) {
  const value = normalizeHtml(html);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193);
    hash = Math.imul(hash ^ (code >>> 8), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The selector the UI stamps on each block; the id is already quoted, so the
 * result is safe for `querySelector` even when it carries a `#n` suffix. */
export function selectorForIndex(blocks, index) {
  const block = blocks[index];
  return block === undefined ? null : block.selector;
}

export function extractBlocks(content, format) {
  const slices = format === "html" ? scanHtmlSlices(content) : scanChunkSlices(content);
  const occurrences = new Map();
  return slices.map((slice) => {
    const html = content.slice(slice.start, slice.end);
    const key = blockKey(html);
    const seen = (occurrences.get(key) || 0) + 1;
    occurrences.set(key, seen);
    // Only repeats get a suffix, so an id stays stable when *other* blocks are
    // inserted or reordered; within one document the suffix keeps ids unique.
    const blockId = seen === 1 ? key : `${key}#${seen}`;
    return {
      blockId,
      selector: `[data-dr-block="${blockId}"]`,
      kind: slice.kind,
      html,
      text: format === "html" ? taggedText(html) : plainText(html),
      offset: slice.start,
      endOffset: slice.end,
    };
  });
}

/**
 * Returns { kind: "comment" | "doctype" | "close" | "open", name?, selfClosing?,
 * end } for markup starting at `start`, or null when the "<" is plain text
 * (as in "a < b"). Scanning is quote-aware so ">" inside an attribute value
 * does not terminate the tag, and an unterminated tag runs to end of input.
 */
function scanTag(content, lower, start) {
  if (content.startsWith("<!--", start)) {
    const close = content.indexOf("-->", start + 4);
    return { kind: "comment", end: close === -1 ? content.length : close + 3 };
  }
  if (content.startsWith("<!", start) || content.startsWith("<?", start)) {
    return { kind: "doctype", end: scanTagEnd(content, start + 2).end };
  }
  let cursor = start + 1;
  let closing = false;
  if (content[cursor] === "/") {
    closing = true;
    cursor += 1;
  }
  TAG_NAME.lastIndex = cursor;
  const match = TAG_NAME.exec(content);
  if (match === null) return null;
  const name = match[0].toLowerCase();
  const scanned = scanTagEnd(content, TAG_NAME.lastIndex);
  if (closing) return { kind: "close", name, end: scanned.end };
  return { kind: "open", name, selfClosing: scanned.selfClosing, end: scanned.end };
}

function scanTagEnd(content, from) {
  let quote = "";
  for (let index = from; index < content.length; index += 1) {
    const char = content[index];
    if (quote !== "") {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return { end: index + 1, selfClosing: content[index - 1] === "/" };
  }
  return { end: content.length, selfClosing: false };
}

/** End of a raw-text element: its body is taken verbatim, and only a `</name`
 * followed by whitespace, "/", or ">" closes it (`</scriptish>` does not). */
function findRawEnd(content, lower, name, from) {
  const needle = `</${name}`;
  let at = lower.indexOf(needle, from);
  while (at !== -1) {
    const after = at + needle.length;
    const char = content[after];
    if (char === undefined) return content.length;
    if (char === ">" || char === "/" || /\s/.test(char)) return scanTagEnd(content, after).end;
    at = lower.indexOf(needle, after);
  }
  return content.length;
}

function scanHtmlSlices(content) {
  const lower = content.toLowerCase();
  const slices = [];
  const stack = [];
  let regionStart = 0;
  let index = 0;

  // Closes the loose-text region ending at `upTo`: a gap holding non-whitespace
  // becomes its own "text" block, pure whitespace is appended to the preceding
  // block, and leading whitespace becomes a "text" block (the partition has no
  // preceding block to inherit it).
  const flush = (upTo) => {
    if (upTo > regionStart) {
      const gap = content.slice(regionStart, upTo);
      if (/\S/.test(gap) || slices.length === 0) {
        slices.push({ start: regionStart, end: upTo, kind: "text" });
      } else {
        slices[slices.length - 1].end = upTo;
      }
    }
    regionStart = upTo;
  };

  while (index < content.length) {
    if (content[index] !== "<") {
      const next = content.indexOf("<", index);
      index = next === -1 ? content.length : next;
      continue;
    }
    const tag = scanTag(content, lower, index);
    if (tag === null) {
      index += 1;
      continue;
    }
    if (tag.kind === "comment" || tag.kind === "doctype") {
      // Comments and doctypes between elements are loose content, not blocks:
      // they stay in the region and merge into a "text" block if they sit
      // between top-level elements.
      index = tag.end;
      continue;
    }
    if (tag.kind === "close") {
      index = tag.end;
      if (stack.length > 0) {
        // A close tag pops the open element regardless of its name; block
        // extraction needs a partition, not conformance.
        stack.pop();
        if (stack.length === 0) {
          slices[slices.length - 1].end = tag.end;
          regionStart = tag.end;
        }
      }
      continue;
    }
    if (VOID_ELEMENTS.has(tag.name) || tag.selfClosing) {
      if (stack.length === 0) {
        flush(index);
        slices.push({ start: index, end: tag.end, kind: "element" });
        regionStart = tag.end;
      }
      index = tag.end;
      continue;
    }
    if (RAW_TEXT_ELEMENTS.has(tag.name)) {
      const rawEnd = findRawEnd(content, lower, tag.name, tag.end);
      if (stack.length === 0) {
        flush(index);
        slices.push({ start: index, end: rawEnd, kind: "element" });
        regionStart = rawEnd;
      }
      index = rawEnd;
      continue;
    }
    if (stack.length === 0) {
      flush(index);
      slices.push({ start: index, end: -1, kind: "element" });
    }
    stack.push(tag.name);
    index = tag.end;
  }

  if (stack.length > 0) {
    // An element left open at EOF is still a block: dropping it would break
    // the partition, so it absorbs everything to the end of input.
    slices[slices.length - 1].end = content.length;
    regionStart = content.length;
  }
  flush(content.length);
  return slices;
}

function scanChunkSlices(content) {
  const raw = [];
  let previous = 0;
  CHUNK_SEPARATOR.lastIndex = 0;
  for (let match = CHUNK_SEPARATOR.exec(content); match !== null; match = CHUNK_SEPARATOR.exec(content)) {
    const end = match.index + match[0].length;
    raw.push({ start: previous, end });
    previous = end;
  }
  if (previous < content.length) raw.push({ start: previous, end: content.length });

  const slices = [];
  for (let index = 0; index < raw.length; index += 1) {
    const slice = raw[index];
    if (index === 0) {
      const leading = LEADING_SPACE.exec(content.slice(slice.start, slice.end));
      if (leading !== null) {
        const split = slice.start + leading[0].length;
        slices.push({ start: slice.start, end: split, kind: "text" });
        if (split < slice.end) slices.push({ start: split, end: slice.end, kind: "chunk" });
        continue;
      }
    }
    slices.push({ start: slice.start, end: slice.end, kind: "chunk" });
  }
  return slices;
}

/** Tag-stripped visible text: markup and invisible bodies are dropped before
 * decoding, so source text like `&lt;div&gt;` survives as literal text. */
function taggedText(html) {
  const lower = html.toLowerCase();
  let visible = "";
  let index = 0;
  while (index < html.length) {
    if (html[index] !== "<") {
      const next = html.indexOf("<", index);
      if (next === -1) {
        visible += html.slice(index);
        break;
      }
      visible += html.slice(index, next);
      index = next;
      continue;
    }
    const tag = scanTag(html, lower, index);
    if (tag === null) {
      visible += "<";
      index += 1;
      continue;
    }
    if (tag.kind === "open" && !tag.selfClosing && INVISIBLE_TEXT_ELEMENTS.has(tag.name)) {
      index = findRawEnd(html, lower, tag.name, tag.end);
      continue;
    }
    index = tag.end;
  }
  return plainText(visible);
}

/** Chunks keep literal angle brackets (markdown prose may contain `<...>`) and
 * are only entity-decoded and whitespace-collapsed. */
function plainText(value) {
  return decodeEntities(value).replace(WHITESPACE, " ").trim();
}

/** One decode level, as a browser's single left-to-right entity pass: the
 * four specific entities decode first so `&amp;lt;` yields `&lt;`, and
 * `&amp;` decodes last so escaped markup is never decoded twice. */
function decodeEntities(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
