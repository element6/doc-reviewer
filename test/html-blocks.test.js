import assert from "node:assert/strict";
import test from "node:test";

import {
  blockKey,
  extractBlocks,
  normalizeHtml,
  selectorForIndex,
} from "../src/html-blocks.js";

const HTML_DOCS = [
  "<div><p>nested one</p><p>nested two</p></div>\n<div><p>second</p></div>",
  '<a href="a>b">link</a><p>after attr</p>',
  "<p>one</p><div>two",
  '<script>var x = "<div>"; if (a < b) {}</script><p>after</p>',
  "<!-- lead --><p>with comment</p> <!-- trail -->",
  "<br>\n<img src='x.png'>\n<p>voids</p>",
  " <p>leading ws</p>   \n\n <p>trailing ws</p>   ",
  "<p>same</p>\n<p>same</p>\n<p>same</p>",
  "<style>p > s { color: red; }</style><textarea>a < b</textarea><title>T</title>",
  "<!DOCTYPE html>\n<html>\n<head><title>D</title></head>\n<body><p>hi</p></body>\n</html>",
  "loose text only < not a tag > here",
  "<p title=\"it's\">attr</p>",
  "",
  "   ",
];

const MD_DOCS = [
  "# Title\n\nFirst para\n\n\nSecond para",
  "\n\nOnly chunks",
  "one line\nstill same chunk\n\nnext chunk   \n\n\n",
  "   indented lead\n\ntail",
  "single chunk no blanks",
  "",
  "   ",
];

test("partition invariant: blocks concatenate back to the source byte-for-byte", () => {
  for (const format of ["html", "markdown", "text"]) {
    for (const content of [...HTML_DOCS, ...MD_DOCS]) {
      const label = `${format}: ${JSON.stringify(content.slice(0, 40))}`;
      const blocks = extractBlocks(content, format);
      assert.equal(blocks.map((block) => block.html).join(""), content, label);
      for (const block of blocks) {
        assert.equal(content.slice(block.offset, endOffset(block)), block.html, label);
        assert.ok(block.offset < endOffset(block), label);
      }
    }
  }
});

function endOffset(block) {
  return block.offset + block.html.length;
}

test("block ids are unique within one document", () => {
  for (const format of ["html", "markdown", "text"]) {
    for (const content of [...HTML_DOCS, ...MD_DOCS]) {
      const blocks = extractBlocks(content, format);
      assert.equal(new Set(blocks.map((block) => block.blockId)).size, blocks.length);
    }
  }
});

test("blockKey and blockId stay stable when other blocks are inserted before", () => {
  const before = extractBlocks("<p>alpha</p><p>beta</p>", "html");
  const after = extractBlocks("<p>gamma</p><p>alpha</p><p>beta</p>", "html");
  assert.equal(after[1].blockId, before[0].blockId);
  assert.equal(after[2].blockId, before[1].blockId);
  assert.notEqual(after[0].blockId, before[0].blockId);
  assert.equal(blockKey("<P>alpha</P>"), blockKey("<p>alpha</p>"));
  // Case is content, not formatting: "alpha" to "Alpha" is a real edit the reviewer must
  // see, so only markup is case-folded and text keeps its case.
  assert.notEqual(blockKey("<p>alpha</p>"), blockKey("<p>Alpha</p>"));
  assert.equal(normalizeHtml("<P>Hello\n  World</P>"), "<p>Hello World</p>");
});

test("repeated identical content gets distinct ids", () => {
  const blocks = extractBlocks("<p>same</p>\n<p>same</p>\n<p>same</p>", "html");
  const ids = blocks.map((block) => block.blockId);
  assert.equal(new Set(ids).size, 3);
  assert.ok(!ids[0].includes("#"));
  assert.ok(ids[1].endsWith("#2"));
  assert.ok(ids[2].endsWith("#3"));
});

test("selectorForIndex output looks up the right block", () => {
  const blocks = extractBlocks("<p>one</p><p>two</p>", "html");
  const selector = selectorForIndex(blocks, 1);
  assert.equal(selector, `[data-dr-block="${blocks[1].blockId}"]`);
  const match = /^\[data-dr-block="(.+)"\]$/.exec(selector);
  assert.ok(match);
  assert.equal(blocks.find((block) => block.blockId === match[1]), blocks[1]);
  assert.equal(selectorForIndex(blocks, 9), null);
});

test("raw-text bodies are not scanned as tags", () => {
  const script = extractBlocks('<script>var x = "<div>"; if (a < b) {}</script><p>after</p>', "html");
  assert.equal(script.length, 2);
  assert.equal(script[0].html, '<script>var x = "<div>"; if (a < b) {}</script>');
  assert.equal(script[0].text, "");
  assert.equal(script[1].html, "<p>after</p>");

  const raw = extractBlocks("<style>p > s { }</style><textarea>a < b</textarea>", "html");
  assert.equal(raw.length, 2);
  assert.equal(raw[0].html, "<style>p > s { }</style>");
  assert.equal(raw[1].html, "<textarea>a < b</textarea>");
  assert.equal(raw[1].text, "a < b");
});

test("an unclosed tag at EOF still produces a block", () => {
  const blocks = extractBlocks("<p>one</p><div>two", "html");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].html, "<p>one</p>");
  assert.equal(blocks[1].kind, "element");
  assert.equal(blocks[1].html, "<div>two");
});

test("comments, doctypes and void elements keep the partition", () => {
  const comments = extractBlocks("<!-- lead --><p>with comment</p> <!-- trail -->", "html");
  assert.deepEqual(comments.map((block) => block.kind), ["text", "element", "text"]);
  assert.equal(comments[0].html, "<!-- lead -->");

  const voids = extractBlocks("<br>\n<img src='x.png'>\n<p>voids</p>", "html");
  assert.deepEqual(voids.map((block) => block.kind), ["element", "element", "element"]);
  assert.equal(voids[0].html, "<br>\n");
  assert.equal(voids[1].html, "<img src='x.png'>\n");

  const doc = extractBlocks("<!DOCTYPE html>\n<html><body><p>hi</p></body></html>", "html");
  assert.equal(doc.length, 2);
  assert.equal(doc[0].kind, "text");
  assert.equal(doc[0].html, "<!DOCTYPE html>\n");
  assert.equal(doc[1].html, "<html><body><p>hi</p></body></html>");
});

test("a > inside a quoted attribute value does not end the tag", () => {
  const blocks = extractBlocks('<a href="a>b">link</a>', "html");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].html, '<a href="a>b">link</a>');
  assert.equal(blocks[0].text, "link");
});

test("pure whitespace between elements attaches to the preceding block", () => {
  const blocks = extractBlocks("<p>a</p>   \n\n  <p>b</p>", "html");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].html, "<p>a</p>   \n\n  ");
  assert.equal(blocks[1].html, "<p>b</p>");
});

test("leading whitespace becomes its own text block", () => {
  const blocks = extractBlocks("  \n<p>x</p>", "html");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, "text");
  assert.equal(blocks[0].html, "  \n");
  assert.equal(blocks[1].kind, "element");
  assert.deepEqual(extractBlocks("", "html"), []);
});

test("text is entity-decoded once and whitespace-collapsed", () => {
  const blocks = extractBlocks(
    '<p title="x">Tom &amp; Jerry &lt;3 &quot;q&quot; &#39;s&#39;\n     two &amp;lt;</p>',
    "html",
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "Tom & Jerry <3 \"q\" 's' two &lt;");
});

test("text strips tags and collapses whitespace", () => {
  const blocks = extractBlocks("<p>a\n   <b>bold</b>   c</p>", "html");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "a bold c");
  assert.equal(extractBlocks("<br><hr>", "html")[0].text, "");
});

test("markdown splits on blank-line runs and keeps the separators", () => {
  const blocks = extractBlocks("# Title\n\nFirst para\n\n\nSecond para", "markdown");
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((block) => block.kind), ["chunk", "chunk", "chunk"]);
  assert.equal(blocks[0].html, "# Title\n\n");
  assert.equal(blocks[1].html, "First para\n\n\n");
  assert.equal(blocks[2].html, "Second para");
});

test("markdown leading whitespace is its own text block", () => {
  const blocks = extractBlocks("\n\nOnly chunks", "markdown");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, "text");
  assert.equal(blocks[0].html, "\n\n");
  assert.equal(blocks[1].kind, "chunk");
  assert.equal(blocks[1].html, "Only chunks");
});

test("plain text chunks behave like markdown chunks", () => {
  const blocks = extractBlocks("one line\nstill same chunk\n\nnext chunk", "text");
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((block) => block.kind === "chunk"));
  assert.equal(blocks[0].html, "one line\nstill same chunk\n\n");

  const indented = extractBlocks("   indented lead\n\ntail", "text");
  assert.equal(indented[0].kind, "text");
  assert.equal(indented[1].kind, "chunk");
});
