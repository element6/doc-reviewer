/**
 * Unified-diff engine: parse and apply `git diff` output for exactly one document.
 *
 * Pure: no DOM, no I/O, so it runs in the browser and under `node --test`.
 * Strict by design: the app controls the base text it gave the AI, so a hunk that
 * does not match at the line its header declares is real information, not noise.
 * Mismatches are reported as `context-mismatch`; there is no fuzzy offset search.
 */

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

// What `git diff` may print outside a hunk. File names are informational: one
// envelope describes one document, so `--- `/`+++ ` headers are counted (a second
// pair is another document) but their names are never trusted.
const PREAMBLE_PREFIXES = [
  "diff --git ", "index ", "old mode ", "new mode ", "new file mode ",
  "deleted file mode ", "similarity index ", "dissimilarity index ",
  "rename from ", "rename to ", "copy from ", "copy to ",
];

const stripCR = (line) => (line.endsWith("\r") ? line.slice(0, -1) : line);

function excerpt(value) {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

/**
 * Split base content into lines for 1-based hunk addressing. The rule: split on
 * "\n"; a final "" produced by the trailing newline is the terminator, not a line,
 * and is dropped, while a blank line before that terminator is a real line and is
 * kept — "a\n\n" is the lines ["a", ""] plus a trailing newline, and an empty
 * document is zero lines. Each line sheds one trailing "\r"; the base's style
 * (CRLF when the base contains any "\r\n", else LF) is re-applied when joining, so
 * a CRLF document stays CRLF instead of silently converting to LF.
 */
function splitDocument(text) {
  const newline = text.endsWith("\n");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return {
    lines: lines.map(stripCR),
    newline,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

function countReason(hunk, seenOld, seenNew) {
  return `declared counts (${hunk.oldCount} old, ${hunk.newCount} new) disagree with `
    + `the body (${seenOld} old, ${seenNew} new)`;
}

/**
 * Consume a hunk's body starting at `startIndex`. Sets `hunk.malformed` when the
 * declared counts disagree with the lines actually present, or returns a hard
 * `error` when the body cannot be delimited at all (for example an empty line
 * inside the hunk: reported, never guessed around).
 */
function readHunkBody(rawLines, startIndex, hunk) {
  let i = startIndex;
  let seenOld = 0;
  let seenNew = 0;
  let prev = null;

  while (i < rawLines.length) {
    const lineNo = i + 1;
    const line = stripCR(rawLines[i]);
    const done = seenOld >= hunk.oldCount && seenNew >= hunk.newCount;

    if (line === NO_NEWLINE_MARKER) {
      if (prev === null) {
        return { error: `line ${lineNo}: "${NO_NEWLINE_MARKER}" must follow a hunk line` };
      }
      if (prev.noNewline) {
        return { error: `line ${lineNo}: duplicate "${NO_NEWLINE_MARKER}"` };
      }
      prev.noNewline = true;
      i += 1;
      continue;
    }

    const prefix = line[0];
    const isFileHeader = line.startsWith("--- ") || line.startsWith("+++ ");

    if (prefix === " " || prefix === "-" || prefix === "+") {
      if (done) {
        // The `--- `/`+++ ` headers of a following file, or stray body lines when
        // the header under-counted. Either way this hunk cannot be trusted.
        if (isFileHeader) break;
        hunk.malformed = countReason(hunk, seenOld, seenNew);
        i += 1;
        while (i < rawLines.length) {
          const stray = stripCR(rawLines[i]);
          const strayPrefix = stray[0];
          const strayHeader = stray.startsWith("--- ") || stray.startsWith("+++ ");
          if ((strayPrefix === " " || strayPrefix === "-" || strayPrefix === "+") && !strayHeader) {
            i += 1;
            continue;
          }
          break;
        }
        break;
      }
      const entry = {
        type: prefix === " " ? "context" : prefix === "-" ? "remove" : "add",
        text: line.slice(1),
        noNewline: false,
      };
      hunk.lines.push(entry);
      prev = entry;
      if (entry.type !== "add") seenOld += 1;
      if (entry.type !== "remove") seenNew += 1;
      i += 1;
      continue;
    }

    if (done) break;
    if (line.startsWith("@@") || PREAMBLE_PREFIXES.some((p) => line.startsWith(p))) {
      // The body ended early at a line that belongs outside it.
      hunk.malformed = countReason(hunk, seenOld, seenNew);
      break;
    }
    return {
      error: `line ${lineNo}: hunk line must start with " ", "-" or "+", found "${excerpt(line)}"`,
    };
  }

  if (!hunk.malformed && (seenOld < hunk.oldCount || seenNew < hunk.newCount)) {
    hunk.malformed = countReason(hunk, seenOld, seenNew);
  }
  return { next: i };
}

/**
 * Parse a unified diff for one document. Structural failures (an unparseable
 * header, a line that cannot be classified, a second file's headers) are
 * `{ ok: false, errors }`; a hunk whose declared counts disagree with its body
 * stays in `hunks` flagged `malformed` so the caller can report it per hunk.
 */
export function parseUnifiedDiff(diffText) {
  const text = String(diffText);
  if (text === "") return { ok: true, hunks: [] };

  const rawLines = text.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();

  const errors = [];
  const hunks = [];
  let oldHeaders = 0;
  let newHeaders = 0;
  let i = 0;

  while (i < rawLines.length) {
    const lineNo = i + 1;
    const line = stripCR(rawLines[i]);

    if (line.startsWith("@@")) {
      const header = HUNK_HEADER_RE.exec(line);
      if (!header) {
        errors.push({ message: `line ${lineNo}: malformed hunk header "${line}"` });
        return { ok: false, errors };
      }
      const hunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
        malformed: null,
      };
      if (hunk.oldCount > 0 && hunk.oldStart < 1) {
        errors.push({ message: `line ${lineNo}: hunk header starts at line ${hunk.oldStart} with a non-zero count` });
        return { ok: false, errors };
      }
      const body = readHunkBody(rawLines, i + 1, hunk);
      if (body.error) {
        errors.push({ message: body.error });
        return { ok: false, errors };
      }
      i = body.next;
      hunks.push(hunk);
      continue;
    }

    if (line.startsWith("--- ")) {
      oldHeaders += 1;
      if (oldHeaders > 1) {
        errors.push({ message: `line ${lineNo}: one document per envelope: a second "--- " header starts another file's diff` });
        return { ok: false, errors };
      }
      i += 1;
      continue;
    }
    if (line.startsWith("+++ ")) {
      newHeaders += 1;
      if (newHeaders > 1) {
        errors.push({ message: `line ${lineNo}: one document per envelope: a second "+++ " header starts another file's diff` });
        return { ok: false, errors };
      }
      i += 1;
      continue;
    }
    if (PREAMBLE_PREFIXES.some((p) => line.startsWith(p))) {
      i += 1;
      continue;
    }
    errors.push({ message: `line ${lineNo}: unrecognized line outside a hunk "${excerpt(line)}"` });
    return { ok: false, errors };
  }

  if (oldHeaders !== newHeaders) {
    errors.push({ message: "unpaired \"--- \"/\"+++ \" file header" });
    return { ok: false, errors };
  }
  return { ok: true, hunks };
}

function verifyAgainstBase(hunk, baseLines) {
  let offset = 0;
  for (const line of hunk.lines) {
    if (line.type === "add") continue;
    const position = hunk.oldStart - 1 + offset;
    offset += 1;
    const found = position < baseLines.length ? baseLines[position] : null;
    if (found === null || found !== line.text) {
      const foundText = found === null ? "end of document" : `"${excerpt(found)}"`;
      return `line ${position + 1}: expected "${excerpt(line.text)}", found ${foundText}`;
    }
  }
  return null;
}

const newSide = (hunk) =>
  hunk.lines.filter((line) => line.type !== "remove").map((line) => line.text);

/**
 * Apply a unified diff to base content. Every hunk that parses is matched at the
 * exact line its header declares against the ORIGINAL base, in order; failures are
 * reported per hunk and skipped, so the caller receives the base with only the
 * good hunks spliced in and can show what landed.
 */
export function applyUnifiedDiff(baseContent, diffText) {
  const parsed = parseUnifiedDiff(diffText);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  const base = splitDocument(baseContent);
  const results = [];
  const splices = [];

  parsed.hunks.forEach((hunk, index) => {
    if (hunk.malformed) {
      results.push({ index, status: "malformed", reason: hunk.malformed });
      return;
    }
    if (hunk.oldCount === 0) {
      // `-L,0` inserts after line L, so position 0 anchors at the top of the file.
      if (hunk.oldStart > base.lines.length) {
        results.push({
          index,
          status: "context-mismatch",
          reason: `line ${hunk.oldStart}: expected an existing line to insert after, found end of document`,
        });
        return;
      }
      splices.push({ index, start: hunk.oldStart, oldCount: 0, newLines: newSide(hunk) });
      results.push({ index, status: "applied" });
      return;
    }
    const mismatch = verifyAgainstBase(hunk, base.lines);
    if (mismatch) {
      results.push({ index, status: "context-mismatch", reason: mismatch });
      return;
    }
    splices.push({ index, start: hunk.oldStart - 1, oldCount: hunk.oldCount, newLines: newSide(hunk) });
    results.push({ index, status: "applied" });
  });

  // Hunk positions are original-base coordinates, so the splices run in ascending
  // position order whatever order the diff listed them in. An overlap can only come
  // from a hand-mangled diff; the later hunk is reported, never merged by guessing.
  splices.sort((a, b) => a.start - b.start);
  const out = [];
  let cursor = 0;
  for (const splice of splices) {
    if (splice.start < cursor) {
      results[splice.index] = {
        index: splice.index,
        status: "malformed",
        reason: "hunk overlaps an earlier hunk",
      };
      continue;
    }
    out.push(...base.lines.slice(cursor, splice.start));
    out.push(...splice.newLines);
    cursor = splice.start + splice.oldCount;
  }
  out.push(...base.lines.slice(cursor));

  // Trailing-newline state: `\ No newline at end of file` marks the EOF of the side
  // it follows — after `+` (or context, which both sides share) the result has no
  // trailing newline; after a lone `-` the new side gained one. With no markers the
  // EOF region is untouched, so the base's style is kept; content written into an
  // empty document gains a newline because git emits the marker when it would not.
  let endsWithNewline;
  if (out.length === 0) {
    endsWithNewline = false;
  } else {
    let addOrContextMarker = false;
    let removeMarker = false;
    for (const result of results) {
      if (result.status !== "applied") continue;
      for (const line of parsed.hunks[result.index].lines) {
        if (!line.noNewline) continue;
        if (line.type === "remove") removeMarker = true;
        else addOrContextMarker = true;
      }
    }
    if (addOrContextMarker) endsWithNewline = false;
    else if (removeMarker) endsWithNewline = true;
    else if (base.lines.length === 0) endsWithNewline = true;
    else endsWithNewline = base.newline;
  }

  const content = out.join(base.eol) + (endsWithNewline ? base.eol : "");
  return { ok: true, content, results };
}
