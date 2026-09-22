import assert from "node:assert/strict";
import test from "node:test";

import {
  FRAGMENT_MAX_BYTES,
  base64UrlToBytes,
  bytesToBase64Url,
  decodeFragment,
  encodeEnvelope,
  parseHash,
} from "../src/channels/hash.js";

function prngString(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let state = 0x9e3779b9;
  let out = "";
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += alphabet[(state >>> 16) & 63];
  }
  return out;
}

const hasGzip =
  typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

test("parseHash reads both channel kinds with or without a leading #", () => {
  assert.deepEqual(parseHash("#d=abc123"), { kind: "envelope", text: "abc123" });
  assert.deepEqual(parseHash("d=abc123"), { kind: "envelope", text: "abc123" });
  assert.deepEqual(parseHash("?d=abc123"), { kind: "envelope", text: "abc123" });
  assert.deepEqual(parseHash("#?d=abc123"), { kind: "envelope", text: "abc123" });
  assert.deepEqual(parseHash("#src=https%3A%2F%2Fexample.com%2Fe.json"), {
    kind: "url",
    url: "https://example.com/e.json",
  });
  assert.deepEqual(parseHash("src=https%3A%2F%2Fexample.com%2Fe.json"), {
    kind: "url",
    url: "https://example.com/e.json",
  });
});

test("parseHash percent-decodes payload values", () => {
  assert.deepEqual(parseHash("#d=%2BwA%2Fpayload%3D"), { kind: "envelope", text: "+wA/payload=" });
  assert.deepEqual(parseHash("#src=%23section-2"), { kind: "url", url: "#section-2" });
});

test("parseHash returns null for junk instead of throwing", () => {
  const junk = ["", "#", "??", "#d", "#d=", "#junk", "#junk=x", "#=v", "#d=%E0%A4%A", "#D=abc"];
  for (const value of junk) {
    assert.equal(parseHash(value), null, `expected null for ${JSON.stringify(value)}`);
  }
  assert.equal(parseHash(42), null);
  assert.equal(parseHash(null), null);
});

test("base64url helpers round-trip every byte value", () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  const decoded = base64UrlToBytes(bytesToBase64Url(bytes));
  assert.deepEqual(Array.from(decoded), Array.from(bytes));
  assert.equal(bytesToBase64Url(new Uint8Array(0)), "");
});

test("base64url helpers match known vectors", () => {
  assert.equal(bytesToBase64Url(Uint8Array.from([0x66])), "Zg");
  assert.equal(bytesToBase64Url(Uint8Array.from([0x66, 0x6f])), "Zm8");
  assert.equal(bytesToBase64Url(Uint8Array.from([0x66, 0x6f, 0x6f])), "Zm9v");
  assert.equal(bytesToBase64Url(Uint8Array.from([0xfb, 0xff])), "-_8");
});

test("base64url decode rejects malformed payloads", () => {
  assert.throws(() => base64UrlToBytes(""), /empty/);
  assert.throws(() => base64UrlToBytes("a"), /invalid length/);
  assert.throws(() => base64UrlToBytes("ab$c"), /invalid character/);
});

test("encode and decode round-trip an envelope through the fragment", async () => {
  const envelope = {
    schema: "doc-reviewer/envelope@1",
    requestId: "req-1",
    doc: { id: "d1", title: "T", format: "html", revision: 1, content: "<p>hi</p>" },
  };
  const fragment = await encodeEnvelope(envelope);
  assert.match(fragment, /^#d=/);
  const parsed = parseHash(fragment);
  assert.equal(parsed.kind, "envelope");
  assert.deepEqual(await decodeFragment(parsed.text), envelope);
  // decodeFragment also tolerates the full fragment string verbatim.
  assert.deepEqual(await decodeFragment(fragment), envelope);
});

test("encodeEnvelope labels the payload gzip when CompressionStream exists", { skip: !hasGzip }, async () => {
  const envelope = { marker: "x".repeat(4096) };
  const fragment = await encodeEnvelope(envelope);
  const text = parseHash(fragment).text;
  assert.ok(text.startsWith("gz."), "gzipped payloads carry an explicit gz. prefix");
  assert.deepEqual(await decodeFragment(text), envelope);
});

const gzipDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CompressionStream");
const canShimGzipOff = !gzipDescriptor || (gzipDescriptor.writable && gzipDescriptor.configurable);

test("encodeEnvelope falls back to an explicit raw payload without CompressionStream", { skip: !canShimGzipOff }, async () => {
  const original = globalThis.CompressionStream;
  globalThis.CompressionStream = undefined;
  try {
    const fragment = await encodeEnvelope({ hello: "world" });
    assert.match(fragment, /^#d=raw\./);
    assert.deepEqual(await decodeFragment(parseHash(fragment).text), { hello: "world" });
  } finally {
    if (original === undefined) delete globalThis.CompressionStream;
    else globalThis.CompressionStream = original;
  }
});

test("decodeFragment rejects junk with a descriptive error", async () => {
  await assert.rejects(decodeFragment(""), /cannot decode fragment payload/);
  await assert.rejects(decodeFragment("!!!not-base64!!!"), /cannot decode fragment payload/);
  // Valid base64url that is neither gzip nor JSON.
  await assert.rejects(decodeFragment("AAAA"), /cannot decode fragment payload/);
});

test("decodeFragment rejects truncated payloads with a descriptive error", async () => {
  const fragment = await encodeEnvelope({
    schema: "doc-reviewer/envelope@1",
    requestId: "truncated",
    doc: { content: "y".repeat(512) },
  });
  const text = parseHash(fragment).text;
  await assert.rejects(decodeFragment(text.slice(0, Math.floor(text.length / 2))), /cannot decode fragment payload/);
  await assert.rejects(decodeFragment(text.slice(0, 10)), /cannot decode fragment payload/);
  // Force the invalid-length branch of the base64url helper.
  await assert.rejects(decodeFragment(text.slice(0, 8)), /cannot decode fragment payload/);
});

test("decodeFragment refuses payloads that are JSON but not objects", async () => {
  const raw = (value) => `raw.${bytesToBase64Url(new TextEncoder().encode(value))}`;
  await assert.rejects(decodeFragment(raw("[1,2]")), /envelope object/);
  await assert.rejects(decodeFragment(raw('"a string"')), /envelope object/);
  await assert.rejects(decodeFragment(raw("42")), /envelope object/);
  await assert.rejects(decodeFragment(raw("null")), /envelope object/);
});

test("encodeEnvelope refuses payloads above the hard fragment cap", async () => {
  const envelope = { doc: { content: prngString(FRAGMENT_MAX_BYTES * 2) } };
  await assert.rejects(encodeEnvelope(envelope), /over the \d+-byte limit for URL fragments/);
});

test("encodeEnvelope warns past the 64 KB threshold without refusing", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await encodeEnvelope({ doc: { content: prngString(128 * 1024) } });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /64 KB warning threshold/);
});
