# doc-reviewer

A review UI for AI-proposed document changes. An AI hands it a document and a proposed
revision; you see the changes as red-struck-through and green-underlaid diffs, accept or
reject each hunk, edit anything by hand, and attach comments to a piece of selected text
or a clicked element. The app then produces a small JSON payload — your decisions, your
final document, and your comments with their locations — to paste back to the AI.

## No server, by design

This is a **pure client-side app**: static files, zero runtime dependencies, no build
step, no backend, no accounts. It can be hosted on GitHub Pages, or opened from any static
host, and it never sends your document anywhere.

That constraint shapes the interface. An AI cannot hold a connection open to a page in
your browser, so the integration point is a **versioned JSON contract** rather than an
API or an MCP server:

- **In:** an `envelope` — the document plus the proposed change.
- **Out:** a `feedback` payload — per-hunk decisions, hand edits, and anchored comments.

Any AI that can write JSON can use this, including models that can only emit text. The
full contract, with worked examples and a prompt snippet, is in
[docs/INTERFACE.md](docs/INTERFACE.md).

If you later want an MCP adapter or an embedded MCP Apps view, either can be layered on
top of the same contract without changing it. Neither is required, and neither is built.

## Getting an envelope in

| Channel | Use it when |
|---|---|
| Drop or pick a `.dr.json` file | Default. Works in every browser, any document size. |
| `#src=<url>` link | The AI can host the envelope somewhere CORS-readable, such as a raw GitHub URL. |
| `#d=<payload>` link | Small documents, and you would rather the text stay out of any request log. |
| Paste the JSON | Always available as a fallback. |

## Getting feedback out

Press **Copy for AI** and paste the result into the AI's next turn, or **Download
feedback.dr.json**. On Chromium you can also nominate an exchange folder once and let the
app read envelopes from `inbox/` and write feedback to `outbox/`, which removes the
copy-paste step entirely without introducing a server.

Sessions are intentionally in-memory. Reloading the page loses the review, so export
before you navigate away; the app warns you if any hunk is still undecided.

## Running it

There is nothing to install and nothing to build.

```sh
open index.html          # quickest look, from the repo root
node scripts/dev-server.js   # optional: http://127.0.0.1:8137, correct module MIME types
node --test              # the test suite
```

The dev server is a development convenience only. It is never required to use the app,
and no browser module imports it.

To host it, publish the repository root with GitHub Pages. `.github/workflows/pages.yml`
runs the tests and deploys on every push to `main`.

## Layout

```
index.html                  page shell
app.css                     design tokens and component styles
src/contract.js             envelope@1 and feedback@1 validators (no DOM, no I/O)
src/diff.js                 word-level diff, ported from the writer precedent
src/html-blocks.js          tolerant block scanner; blocks partition the document
src/state.js                hunk decisions, manual edits, undo/redo
src/anchor.js               comment anchoring and re-location
src/sanitize.js             allowlist sanitizer for untrusted document markup
src/channels/               hash, file, clipboard, File System Access
src/ui/                     document view, diff view, comments, review bar, feedback
schema/                     the two JSON Schemas
docs/INTERFACE.md           the AI-facing contract
docs/USAGE.md               usage and the acceptance checklist
architecture.md             module contract and invariants
```

## Security posture

An envelope is untrusted input from a language model that is rendered as HTML, so it is
treated as hostile. Document markup passes through an allowlist sanitizer before it
becomes DOM, and the page ships a restrictive `Content-Security-Policy` that forbids
network access entirely except the one explicit `#src=` fetch. The app makes no other
request, has no telemetry, and stores nothing on a server because there is no server.
