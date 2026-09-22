# Usage and acceptance checklist

## Reviewing a change

1. Get an envelope into the page: drop a `.dr.json` file on it, open a `#src=` or `#d=`
   link, or paste the JSON. Nothing is applied until the envelope validates; a malformed
   one names the exact field that failed.
2. Read the diff. Removed text is red and struck through, added text is green, and a
   replacement shows the old text stacked above the new one so a swap is not read as a
   run-on sentence.
3. Decide each hunk: `a` accepts, `r` rejects, `[` and `]` move between hunks. **Accept
   all** and **Reject all** are in the review bar. Rejecting a hunk restores the original
   text exactly.
4. Prefer a different wording than either side? Edit it directly. The hunk is then
   reported as `edited` rather than `accepted`, which tells the AI your hand was in it.
5. To comment, select text and press `c`, or click an element on an HTML document. The
   comment travels with its quote, surrounding context, and location.
6. Press **Copy for AI** and paste the payload into the AI's next turn. `result.content`
   is your document as it now stands, so the AI has no need to re-derive it.

## Notes

- **Rendered vs source.** HTML starts in rendered mode and Markdown and plain text start
  in source mode. The toggle switches at any time; your decisions are preserved.
- **Unresolved patch operations.** If the AI sent a `patch` whose `find` text was absent
  or matched more than once, that change did not land. The page says so explicitly.
  A repair is to ask the AI to re-send the change as `kind: "replace"`.
- **Oversized diffs.** If a document is too large to diff reliably, the page falls back to
  whole-block replacement with a visible notice instead of freezing.
- **Sessions are in-memory.** A reload loses the review. Use **Download** to keep a copy,
  and expect a warning if you try to leave with hunks still undecided.
- **Editing is disabled** when the envelope sets `options.allowDirectEdit` to `false`.

## Acceptance checklist

Run through this after any change to the app. Each line is a thing to observe, not to
assume.

### Contract

- [ ] A valid `replace` envelope from a dropped file loads and renders.
- [ ] A valid `patch` envelope resolves and shows only the changed text.
- [ ] A `patch` whose `find` matches nothing reports `not-found` and applies nothing.
- [ ] A `patch` whose `find` matches twice reports `ambiguous` and applies nothing.
- [ ] Malformed JSON, a missing `doc.title`, and an unknown `format` each produce a
      message naming the failing field.
- [ ] `schema: "doc-reviewer/envelope@2"` is refused and names the supported version.
- [ ] An unknown extra field is accepted with a warning, not a failure.

### Review

- [ ] Per-hunk accept changes only that hunk.
- [ ] Per-hunk reject restores the base text byte-for-byte.
- [ ] Accept all reproduces the proposed document byte-for-byte.
- [ ] Reject all reproduces the original document byte-for-byte.
- [ ] A hand edit is reported as `decision: "edited"` and its text appears in
      `result.content`.
- [ ] Undo and redo walk back and forward through decisions and edits.
- [ ] Keyboard-only operation covers navigation, accept, reject, and commenting.

### Comments

- [ ] Selecting text and commenting yields a `text` anchor with `quote`, `prefix`,
      `suffix`, `occurrence`, and `offset`.
- [ ] Clicking an element on an HTML document yields an `element` anchor with `selector`
      and `blockId`.
- [ ] A quote occurring twice produces `occurrence: 0` and `occurrence: 1`.
- [ ] Inserting unrelated text before a comment leaves it anchored to the same words.
- [ ] Deleting the commented text marks the comment stale rather than misplacing it.

### Output

- [ ] `Copy for AI` puts a payload on the clipboard and `Download` writes the same one.
- [ ] The payload validates against `schema/feedback-1.schema.json`.
- [ ] `verdict` reads `accepted`, `rejected`, or `changes-requested` as appropriate.
- [ ] The rendered document never executes script from an envelope, and no request is
      made to a third party while reviewing.

### Hosting

- [ ] The app works opened directly from `index.html` and from the dev server.
- [ ] It works on a GitHub Pages URL, over HTTPS, with no build step.
- [ ] The test suite passes before deploy in the Pages workflow.
