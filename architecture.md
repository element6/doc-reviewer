# architecture.md

Serverless, zero-dependency, zero-build review UI for AI-proposed document changes.
The app is static files served by GitHub Pages. There is no backend, no persistence
layer, and no runtime dependency. Anything that needs a process (the dev server, the
test runner) is development-only and is never required to use the app.

## Why this shape

An AI cannot hold a transport open to a static page in someone's browser, so the
integration point is **data, not a socket**: a versioned JSON envelope in, a versioned
JSON feedback payload out. MCP is deliberately not used — it presupposes a spawned
process and a broker, and the host must render MCP UI resources to show anything, which
is not required to be supported. A future MCP adapter can wrap the same contract files
without changing it (see Deferred).

## Data flow

```
AI  --envelope@1-->  channel (hash | url | file | paste | fs-dir)
                          |
                          v
                     contract.js  (parse + validate + apply proposal)
                          |
                          v
              html-blocks.js -> diff.js -> hunks
                          |
                          v
                   state.js (decisions, manual edits, undo/redo)
                          |
        +-----------------+------------------+
        v                                    v
   ui/*.js renders                    anchor.js (comments)
        |                                    |
        +-----------------+------------------+
                          v
                   contract.js buildFeedback --> feedback@1
                          |
                          v
             clipboard | download | fs-dir outbox  --> AI
```

## Frozen module contract

These signatures are the interface between modules. Do not change one without changing
this file in the same commit (`AGENTS.md` §4).

### `src/contract.js` — owns both schemas, pure, node-testable

Owned by the spine. Already implemented.

```
ENVELOPE_SCHEMA = "doc-reviewer/envelope@1"
FEEDBACK_SCHEMA = "doc-reviewer/feedback@1"
FORMATS = ["html", "markdown", "text"]
MAX_CONTENT_CHARS, MAX_DIFF_CHARS, MAX_TITLE_CHARS, MAX_SUMMARY_CHARS,
MAX_RATIONALE_CHARS, MAX_COMMENT_CHARS, MAX_COMMENTS
class ContractError extends Error { errors: [{path, message}] }

parseEnvelope(input)        -> { ok: true, envelope, warnings } | { ok: false, errors }
applyProposal(doc, proposal)-> { content, opResults: [{ index, status, reason? }] }
buildFeedback(input)        -> feedback object
validateFeedback(raw)       -> { ok, errors }
```

`status` is one of `"applied"`, `"context-mismatch"`, `"malformed"`: a unified hunk that
matched its declared lines, one that did not match the base there, and one whose declared
counts disagree with its body. An envelope still carrying `ops`, or `kind: "patch"`, fails
validation with a message naming `unified`. `applyProposal` short-circuits
`kind: "replace"` (empty `opResults`) and delegates `kind: "unified"` to
`src/unified.js` below.

### `src/unified.js` — unified-diff engine, pure, node-testable

```
parseUnifiedDiff(diffText)  -> { ok: true, hunks } | { ok: false, errors: [{ message }] }
applyUnifiedDiff(base, diffText)
                            -> { ok: true, content, results: [{ index, status, reason? }] }
                             | { ok: false, errors }
```

Applies `git diff` output for exactly one document. Each hunk is matched against the
ORIGINAL base at the exact line its header declares — there is no fuzzy offset search, so
a miss is reported as `context-mismatch` and that hunk does not land while the other
hunks still do. A second `--- `/`+++ ` file-header pair is refused: one document per
envelope. `\ No newline at end of file` and CRLF bases round-trip byte-for-byte.

### `src/diff.js` — pure, node-testable

```
wordTokens(value) -> string[]                      // writer/server.js:51 regex, verbatim
DIFF_WORK_LIMIT = 4_000_000                        // writer/server.js:42, verbatim
diffSegments(base, proposed, opts?) -> { ok: true, parts }
                                     | { ok: false, reason: "work-limit" | "too-long", parts: null }
validDiff(base, proposed, parts) -> boolean        // writer/index.html:245 invariant
hunksFromBlocks(baseBlocks, proposedBlocks) -> { ok, hunks, reason? }
```

`parts` is `[{ type: "keep" | "remove" | "add", text }]` — writer's segment contract.
`validDiff` holds iff concatenating non-`add` parts equals `base` and non-`remove` parts
equals `proposed`.

```
Hunk = { id, kind: "changed" | "added" | "removed", baseText, proposedText, parts,
         baseBlockId, proposedBlockId, baseOffset }
```

`baseBlockId` is `null` for an `"added"` hunk and `proposedBlockId` is `null` for a
`"removed"` hunk. `baseOffset` is the character offset in the base document where the
hunk's base slice starts — **the ordering key**. For an `"added"` hunk it is the offset of
the base block the insertion precedes, or the base document's length when it trails.

**Ordering rule.** `hunksFromBlocks` returns hunks sorted ascending by `baseOffset`, with
`"added"` hunks before non-added ones on a tie, so an insertion lands ahead of the block
it precedes. `state.js` relies on this order and on `baseOffset` being exact; it must
never have to search the document for a hunk's text.

`hunksFromBlocks` compares two block arrays by `blockId`: equal ids pair up (and are
word-diffed when their `html` differs), unmatched base blocks become `removed` hunks,
unmatched proposed blocks become `added` hunks, in document order. `baseText` and
`proposedText` are always the **exact source slices** carried by the blocks, never a
reconstruction, because `state.js` splices them back into the document verbatim.

### `src/html-blocks.js` — pure string scanning, node-testable

No DOM dependency: block boundaries are found by a tolerant tag scanner so the module
runs in the browser and under `node --test` alike. DOM construction happens in `ui/`.

```
extractBlocks(content, format) -> [{ blockId, selector, kind, html, text, offset, endOffset }]
blockKey(html) -> string                            // FNV-1a 32-bit hex of normalized html
normalizeHtml(html) -> string
selectorForIndex(blocks, index) -> string
```

`offset` and `endOffset` are the block's character range in `content`. Blocks are
therefore both an ordered partition and an addressable one, which is what lets `state.js`
order hunks and splice them without re-searching for text.

For `html`, top-level elements are the blocks. For `markdown` and `text`, blocks are
blank-line-separated chunks and `kind` is `"chunk"`. `blockId` must be stable under
reordering and insertion of *other* blocks: it is derived from normalized content, with
a `#n` disambiguating suffix only when identical blocks repeat.

**Partition invariant (load-bearing).** The returned blocks must *partition* the input:
concatenating every block's `html` in order must reproduce `content` byte-for-byte, for
every format. Trailing whitespace belongs to the preceding block; leading whitespace
becomes its own block. `state.js` composes the final document by splicing these exact
source slices, so a gap between slices would silently corrupt round-tripping.

### `src/anchor.js` — pure core, node-testable (to be written)

```
anchorFromText(input) -> anchor          // { sourceText, start, end, blockId?, selector?, label? }
locateAnchor(sourceText, anchor) -> { start, end, exact }
isAnchorStale(sourceText, anchor) -> boolean
describeAnchor(anchor) -> string
```

`anchor` is the W3C Web Annotation text-quote shape: `{ kind, quote, prefix, suffix,
occurrence, offset: { start, end }, selector?, blockId?, label? }`. DOM `Range` to
offset conversion lives in `src/ui/selection.js`, not here.

### `src/state.js` — pure, node-testable (to be written)

Pure bookkeeping over an **already-computed** hunk list, so this module imports neither
`diff.js` nor `html-blocks.js`. Wiring those together is `main.js`'s job:

```
createSession({ envelope, proposedContent, hunks, baseBlocks, opResults }) -> session
decide(session, hunkId, decision) -> session        // "accepted" | "rejected" | "unresolved"
decideAll(session, decision) -> session
setManualEdit(session, blockId, html) -> session
addComment(session, anchor, body) -> session
removeComment(session, commentId) -> session
resultContent(session) -> string
undo(session) / redo(session) -> session
buildFeedbackPayload(session) -> feedback
```

Sessions are treated immutably: every mutator returns a new session object. The
revision stack backs undo/redo. Invariant 3 (rejecting everything reproduces
`doc.content` byte-for-byte) is this module's responsibility.

`resultContent` merges by walking the hunks in their documented order with a cursor into
the base document, never by searching for text:

```
sorted = hunks sorted by baseOffset, "added" first on a tie
cursor = 0; out = ""
for hunk of sorted:
    out += base.slice(cursor, hunk.baseOffset)
    cursor = hunk.baseOffset
    if hunk.kind === "added":
        if decision is accepted or edited: out += edit ?? hunk.proposedText
    else:
        out += chosen(hunk)
        cursor += hunk.baseText.length
out += base.slice(cursor)
```

`chosen(hunk)` is `edits[blockId]` for the side the decision selects
(`proposedBlockId` when accepted or edited, `baseBlockId` when rejected), falling back to
`hunk.proposedText` for accepted/edited and `hunk.baseText` for rejected or unresolved.

Because `baseBlocks` is supplied, `setManualEdit` works on **any** block, including one no
hunk covers: an edit to an unchanged block is emitted through a synthetic `"changed"`
hunk whose `baseText` and `proposedText` are both the block's original html, with
decision `"edited"`. That synthetic hunk appears in feedback too, since a hand edit is
information the AI should receive.

### `src/sanitize.js` — allowlist sanitizer (to be written)

```
ALLOWED_TAGS, ALLOWED_ATTRS, SAFE_URL_SCHEMES
isSafeUrl(url) -> boolean                        // pure
isAllowedTag(tag) -> boolean                     // pure
isAllowedAttribute(tag, name, value) -> boolean   // pure; the whole policy, testable in node
sanitizeHtml(html, { document }) -> string        // document injected for testability
```

`sanitizeHtml` is the only place untrusted markup becomes DOM. It strips
`script|iframe|object|embed|link|meta|base|form` and their content, every `on*`
attribute, `javascript:`/`data:` URLs, and inline `style` `url()`/`expression`.

### `src/channels/*.js` — transport (to be written)

```
hash.js       parseHash(hash) -> { kind:"envelope", text } | { kind:"url", url } | null
              encodeEnvelope(envelope) -> Promise<string>   // gzip + base64url; guards for missing CompressionStream
              decodeFragment(value) -> Promise<object>
file.js       readEnvelopeFromFiles(files) -> Promise<text>
clipboard.js  copyText(text) -> Promise<boolean>
              readText() -> Promise<string>
fsaccess.js   isSupported() -> boolean
              pickDirectory() -> Promise<handle>
              pollInbox(handle, onEnvelope) / writeOutbox(handle, name, text)
```

`clipboard.js` and `fsaccess.js` degrade to `false`/no-op when the API or secure context
is absent; no caller may assume success.

## Invariants

1. Untrusted input never reaches `innerHTML` except through `sanitizeHtml`.
2. A change that cannot be applied exactly is reported, never guessed at: a unified
   hunk whose context misses the base comes back `context-mismatch` and does not land,
   and hunks that fail `validDiff` are reported as an error, never rendered as a diff.
3. Rejecting every hunk reproduces `doc.content` byte-for-byte.
4. Unknown `schema` versions are refused; unknown *fields* are ignored with a warning.
5. No network request except the explicit `#src=` fetch, and no `eval`, `Function`, or
   dynamic `import` of document-supplied strings.

## Deferred (not built)

A thin local MCP adapter over the same `inbox/`/`outbox/` JSON files, and an MCP Apps
`ui://` resource for hosts that support embedding. Both are additive.
