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
    // A shipped example must not use fields the contract no longer knows.
    assert.deepEqual(result.warnings, [], `examples/${file} warns: ${result.warnings.join("; ")}`);
    parsed = result.envelope;

    // An example that cannot be applied teaches nothing, so resolve the proposal too.
    const applied = applyProposal(parsed.doc, parsed.proposal);
    assert.equal(typeof applied.content, "string");
    assert.notEqual(applied.content, parsed.doc.content, `examples/${file} proposes no change`);
    for (const record of applied.opResults) {
      assert.ok(
        ["applied", "context-mismatch", "malformed"].includes(record.status),
        `unexpected op status ${record.status}`,
      );
    }
  });
}

test("the unified example applies its diff cleanly against its own document", () => {
  const result = parseEnvelope(readFileSync(path.join(EXAMPLES_DIR, "unified-deploy.dr.json"), "utf8"));
  assert.equal(result.ok, true);
  const applied = applyProposal(result.envelope.doc, result.envelope.proposal);
  assert.ok(applied.opResults.length > 0, "the unified example should carry at least one hunk");
  for (const record of applied.opResults) {
    assert.equal(record.status, "applied", `hunk ${record.index} failed: ${record.reason ?? ""}`);
  }
  assert.ok(applied.content.includes("2. Run the migration."));
  assert.ok(applied.content.includes("Rollback is documented in ops/runbook.md."));
});

test("the html example is an html document with several blocks", () => {
  const result = parseEnvelope(readFileSync(path.join(EXAMPLES_DIR, "article.dr.json"), "utf8"));
  assert.equal(result.ok, true);
  assert.equal(result.envelope.doc.format, "html");
  assert.ok(result.envelope.doc.content.includes("<h1>"));
});
