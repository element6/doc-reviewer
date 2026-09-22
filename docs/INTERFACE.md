# The AI interface

`doc-reviewer` has no server and no API endpoint. An AI integrates with it by producing
and consuming **two JSON documents**:

| Direction | Artifact | Schema |
|---|---|---|
| AI → reviewer | an **envelope**: the document plus your proposed change | `schema/envelope-1.schema.json` |
| reviewer → AI | **feedback**: the human's decisions and comments | `schema/feedback-1.schema.json` |

Because both are plain JSON, any model or agent can use this with no SDK, no MCP server,
and no installation. If you can emit JSON and read JSON, you are integrated.

## Handing an envelope to the human

Pick whichever channel the human can act on. All three carry the identical envelope.

1. **Write a file** — save the envelope as `something.dr.json` and let the human drag it
   onto the page or pick it with the file button. Works everywhere, any size.
2. **Send a link** — put the envelope at a CORS-readable URL (a GitHub raw URL or gist is
   ideal, since `raw.githubusercontent.com` sends permissive CORS headers) and give the
   human `https://<host>/#src=<url-encoded-url>`. Best for large documents.
3. **Send an inline link** — for a small document, `https://<host>/#d=<payload>` where
   `<payload>` is the base64url of the gzipped envelope JSON. This keeps the document out
   of any server log, but URLs have length limits: keep it under roughly 64 KB of
   compressed payload, and prefer channel 1 or 2 above that.

The page also accepts a pasted envelope, so "here is the JSON, paste it into the box" is
always a valid fallback instruction.

## Reading feedback

Ask the human to press **Copy for AI** and paste the result into your next turn. Then:

- `verdict` is the overall outcome: `accepted`, `rejected`, or `changes-requested`.
- `result.content` is the document as it now stands, **after** accepted hunks and any
  hand edits. Treat this as the new source of truth and use it as the base for your next
  revision.
- `hunks[]` tells you which of your changes survived. `decision` is `accepted`,
  `rejected`, `edited`, or `unresolved`. A hunk you proposed that came back `rejected`
  must not be re-proposed unchanged.
- `comments[]` is the human's actual feedback, each anchored to a location. This is the
  most valuable field: it is what the human wanted to say that a diff cannot express.

A payload where every hunk is `unresolved` means the human did not finish reviewing — do
not treat it as approval.

## `envelope@1`

```json
{
  "schema": "doc-reviewer/envelope@1",
  "requestId": "any-opaque-id-you-invent",
  "doc": {
    "id": "release-notes",
    "title": "Release notes",
    "format": "markdown",
    "revision": 3,
    "content": "Shipped on Jan 3.\n\nKnown issues: none.\n"
  },
  "proposal": {
    "kind": "unified",
    "diff": "diff --git a/notes-old.md b/notes-new.md\nindex 5a368f9..ecc1485 100644\n--- a/notes-old.md\n+++ b/notes-new.md\n@@ -1,3 +1,3 @@\n-Shipped on Jan 3.\n+Shipped on March 3.\n \n-Known issues: none.\n+Known issues: see the tracker.\n",
    "summary": "Corrected the date and the known-issues line.",
    "rationale": "Optional. Why you made these changes."
  },
  "options": { "allowDirectEdit": true }
}
```

### Fields

| Field | Required | Notes |
|---|---|---|
| `schema` | yes | Exactly `doc-reviewer/envelope@1`. |
| `requestId` | yes | Non-empty string, echoed back in feedback so you can match the round trip. |
| `doc.id` | yes | Non-empty string. |
| `doc.title` | yes | 1–300 characters. |
| `doc.format` | yes | `html`, `markdown`, or `text`. |
| `doc.revision` | yes | Integer ≥ 1. Identifies the base you diffed against; echoed back. |
| `doc.content` | yes | The current document as source text. May be empty. |
| `proposal.kind` | yes | `unified` (preferred) or `replace`. |
| `proposal.content` | for `replace` | The full proposed document. |
| `proposal.diff` | for `unified` | Standard unified diff of this one document, see below. |
| `proposal.summary` | no | Short human-facing description, shown to the human. |
| `proposal.rationale` | no | Shown to the human. |
| `options.allowDirectEdit` | no | Default `true`. `false` makes the document read-only. |

Unknown fields are ignored with a warning, so you may add your own metadata. An unknown
`schema` **version** is refused outright.

### `unified` (preferred)

Send the output of `git diff` against the `doc.content` you were given. The reviewer
applies it strictly:

- **Strict context.** Each hunk applies only at the exact line its header declares,
  checked against the original `doc.content` — no fuzzy searching and no offset search. A
  hunk whose context does not match is reported back as `context-mismatch` and does not
  land; the other hunks in the same diff still apply. A hunk whose declared counts
  disagree with its body is reported as `malformed`.
- **One document per envelope.** A diff whose file headers describe more than one file is
  refused outright. Propose one document per envelope.
- `\ No newline at end of file` and CRLF documents round-trip byte-for-byte.
- **Line endings are normalised on apply.** The whole document is re-joined with a
  single style — CRLF if the content contains any `\r\n`, otherwise LF — so applying a
  hunk to a mixed-ending document also changes the endings of untouched lines.
  Uniform-ending documents are unaffected.

```json
{
  "schema": "doc-reviewer/envelope@1",
  "requestId": "fix-dates",
  "doc": { "id": "notes", "title": "Notes", "format": "markdown", "revision": 1,
           "content": "Shipped on Jan 3.\n\nKnown issues: none.\n" },
  "proposal": {
    "kind": "unified",
    "diff": "diff --git a/notes-old.md b/notes-new.md\nindex 5a368f9..ecc1485 100644\n--- a/notes-old.md\n+++ b/notes-new.md\n@@ -1,3 +1,3 @@\n-Shipped on Jan 3.\n+Shipped on March 3.\n \n-Known issues: none.\n+Known issues: see the tracker.\n",
    "summary": "Corrected the date and the known-issues line."
  }
}
```

The `index`, `--- ` and `+++ ` header lines are accepted and ignored; the hunks are what
matters. An envelope that still carries `ops`, or `kind: "patch"`, fails validation with a
message naming `unified`.

### `replace`

Use `replace` only when you have the complete new text of the document. You send the
whole proposed document and the reviewer computes the diff for you. It cannot fail and
needs no anchor guessing, but it costs a full re-send of the document, so prefer
`unified` for ordinary edits.

```json
{
  "schema": "doc-reviewer/envelope@1",
  "requestId": "fix-dates",
  "doc": { "id": "notes", "title": "Notes", "format": "markdown", "revision": 1,
           "content": "Shipped on Jan 3.\n\nKnown issues: none.\n" },
  "proposal": {
    "kind": "replace",
    "content": "Shipped on March 3.\n\nKnown issues: see the tracker.\n",
    "summary": "Corrected the date and the known-issues line."
  }
}
```

### HTML documents

Send well-formed HTML. The document is sanitized on arrival, so scripts, event handlers,
iframes, forms, and `javascript:` URLs are removed before anything is rendered — do not
rely on them. Structure is preserved: the reviewer renders your markup as a document and
diffs it block by block, so wrapping a changed sentence in its own `<p>` produces a
cleaner review than editing text inside a deeply nested element. On an HTML document the
human can also attach a comment to a whole element by clicking it, which arrives in
feedback as an `element` anchor with a CSS `selector`.

## `feedback@1`

```json
{
  "schema": "doc-reviewer/feedback@1",
  "requestId": "fix-dates",
  "doc": { "id": "notes", "revision": 1 },
  "verdict": "changes-requested",
  "result": { "format": "markdown", "content": "The accepted document text." },
  "hunks": [
    { "id": "h1", "decision": "accepted", "base": "Jan 3", "proposed": "March 3" }
  ],
  "comments": [
    {
      "id": "c1",
      "body": "This date is still wrong - we shipped on the 5th.",
      "createdAt": "2024-05-01T10:00:00.000Z",
      "anchor": {
        "kind": "text",
        "quote": "March 3",
        "prefix": "Shipped on ",
        "suffix": ".",
        "occurrence": 0,
        "offset": { "start": 11, "end": 18 },
        "blockId": "9f2a41c7",
        "label": "paragraph 1"
      }
    }
  ]
}
```

### Using comments to locate what the human meant

`anchor.quote` is the selected text; `anchor.prefix` and `anchor.suffix` are up to 40
characters of surrounding context. Together they identify the target even after the
document has shifted.

- Prefer locating by `quote` plus context rather than by `offset`. Offsets are into
  `result.content` as it stood when the comment was made, so they are a hint, not a
  contract.
- `occurrence` disambiguates a quote that appears more than once: `0` is the first match.
- `kind: "element"` means the human clicked a whole element rather than selecting text.
  Then `selector` (a CSS selector such as `[data-dr-block="9f2a41c7"]`) and `blockId` are
  the precise target, and `quote` is that element's text.
- `label` is a human-readable description of the location, useful when you need to tell
  the human what you are about to change.

## A prompt snippet you can hand to an AI

> Produce change requests for `doc-reviewer` as a single JSON object with
> `schema: "doc-reviewer/envelope@1"`, a `requestId`, a `doc` object
> (`id`, `title`, `format` one of `html|markdown|text`, `revision`, `content`), and a
> `proposal` with `kind: "unified"` carrying `diff` — the standard unified diff output of
> `git diff` against the `doc.content` you were given, for this one document only. Use
> `kind: "replace"` with the full proposed `content` only when you already have the
> complete new text. Add an optional `summary`. Output only the JSON, no commentary and
> no code fence. Then tell the human to drop the file onto the reviewer page. When the
> human pastes feedback back, read `result.content` as the new document, treat
> `hunks[].decision` as the record of what was accepted or rejected, and act on every
> `comments[]` entry using its `anchor.quote` plus context to locate the text. Never
> re-propose a change that came back `rejected`.

## Versioning

The `schema` field is the version. This build supports `envelope@1` and emits
`feedback@1`. A different version is refused with a message naming the supported version,
so a mismatch fails loudly instead of being misread. Additive fields do not require a new
version; changing the meaning of an existing field does.

## Limits

| Limit | Value |
|---|---|
| `doc.content` and `proposal.content` | 2,000,000 characters |
| `proposal.diff` | 4,000,000 characters |
| `proposal.summary` | 8,000 characters |
| `proposal.rationale` | 8,000 characters |
| Comment body | 8,000 characters |
| Comments per review | 500 |
| Inline `#d=` link payload | warn above 64 KB compressed, refuse above 512 KB |
