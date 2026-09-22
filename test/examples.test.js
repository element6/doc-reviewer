/**
 * The shipped examples are documentation, so they must stay valid as the contract
 * evolves. This suite is what stops docs/INTERFACE.md from quietly rotting.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { applyProposal, parseEnvelope } from "../src/contract.js";

const EXAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");

const files = readdirSync(EXAMPLES_DIR).filter((name) => name.endsWith(".dr.json"));

test("there is at least one example envelope to check", () => {
  assert.ok(files.length >= 3, `expected several examples, found ${files.length}`);
});

for (const file of files) {
  test(`examples/${file} is valid JSON and a valid envelope@1`, () => {
    const raw = readFileSync(path.join(EXAMPLES_DIR, file), "utf8");
    let parsed;
    assert.doesNotThrow(() => JSON.parse(raw), `examples/${file} is not valid JSON`);

    const result = parseEnvelope(raw);
    assert.equal(
      result.ok,
      true,
      `examples/${file} failed validation: ${JSON.stringify(result.errors)}`,
    );
    parsed = result.envelope;

    // An example that cannot be applied teaches nothing, so resolve the proposal too.
    const applied = applyProposal(parsed.doc, parsed.proposal);
    assert.equal(typeof applied.content, "string");
    assert.notEqual(applied.content, parsed.doc.content, `examples/${file} proposes no change`);
    for (const record of applied.opResults) {
      assert.ok(
        ["applied", "not-found", "ambiguous"].includes(record.status),
        `unexpected op status ${record.status}`,
      );
    }
  });
}

test("the patch example demonstrates an unresolved operation on purpose", () => {
  const result = parseEnvelope(readFileSync(path.join(EXAMPLES_DIR, "patch-deploy.dr.json"), "utf8"));
  assert.equal(result.ok, true);
  const applied = applyProposal(result.envelope.doc, result.envelope.proposal);
  assert.ok(
    applied.opResults.some((record) => record.status === "not-found"),
    "the patch example should show what a not-found operation looks like",
  );
});

test("the html example is an html document with several blocks", () => {
  const result = parseEnvelope(readFileSync(path.join(EXAMPLES_DIR, "article.dr.json"), "utf8"));
  assert.equal(result.ok, true);
  assert.equal(result.envelope.doc.format, "html");
  assert.ok(result.envelope.doc.content.includes("<h1>"));
});
