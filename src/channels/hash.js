/**
 * URL-fragment channel: an envelope travels over `location.hash` as `#d=<payload>`.
 *
 * Compression is opportunistic — gzip only when CompressionStream exists — and the
 * codec is stated explicitly in the payload (`gz.` / `raw.`) so decoding never has to
 * guess. Pure helpers are exported so the tests cover parsing and base64url under
 * node, where CompressionStream may be missing. See architecture.md, channels section.
 */

export const FRAGMENT_WARN_BYTES = 64 * 1024;
export const FRAGMENT_MAX_BYTES = 512 * 1024;

const CODEC_GZIP_PREFIX = "gz.";
const CODEC_RAW_PREFIX = "raw.";

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_INDEX = new Map([...B64URL_ALPHABET].map((character, index) => [character, index]));

function describe(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function bytesToBase64Url(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;
    const b1 = hasB1 ? bytes[i + 1] : 0;
    const b2 = hasB2 ? bytes[i + 2] : 0;
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    if (!hasB1) break;
    out += B64URL_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)];
    if (!hasB2) break;
    out += B64URL_ALPHABET[b2 & 63];
  }
  return out;
}

export function base64UrlToBytes(text) {
  if (typeof text !== "string") throw new Error("base64url payload must be a string");
  const payload = text.replace(/=+$/, "");
  if (payload.length === 0) throw new Error("base64url payload is empty");
  // One leftover sextet is never a valid tail; anything else decodes cleanly without padding.
  if (payload.length % 4 === 1) throw new Error(`base64url payload has invalid length ${payload.length}`);
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (const character of payload) {
    const value = B64URL_INDEX.get(character);
    if (value === undefined) {
      throw new Error(`base64url payload contains invalid character ${JSON.stringify(character)}`);
    }
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Accepts `#d=`/`#src=` with or without the leading `#`, tolerates `?`/`&` style
 * separators, percent-decodes the value, and returns null for anything unrecognized
 * instead of throwing — a hand-edited address bar is untrusted input.
 */
export function parseHash(hash) {
  if (typeof hash !== "string") return null;
  const body = hash.trim().replace(/^[#?&]+/, "");
  const separator = body.indexOf("=");
  if (separator <= 0) return null;
  const key = body.slice(0, separator);
  const raw = body.slice(separator + 1);
  if (raw.length === 0) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (key === "d") return { kind: "envelope", text: decoded };
  if (key === "src") return { kind: "url", url: decoded };
  return null;
}

function concatBytes(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function transformBytes(bytes, transform) {
  const writer = transform.writable.getWriter();
  // A write rejection only mirrors a failure the read side surfaces as well, so the
  // authoritative error arrives through reader.read() below; leave these handlers in
  // place so a mirrored rejection cannot crash node as an unhandled rejection.
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const chunks = [];
  const reader = transform.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concatBytes(chunks);
}

export async function encodeEnvelope(envelope) {
  let json;
  try {
    json = JSON.stringify(envelope);
  } catch (error) {
    throw new Error(`doc-reviewer: cannot encode envelope: ${describe(error)}`);
  }
  if (typeof json !== "string") {
    throw new Error("doc-reviewer: cannot encode envelope: value is not JSON-serialisable");
  }
  const raw = new TextEncoder().encode(json);
  let bytes = raw;
  let prefix = CODEC_RAW_PREFIX;
  if (typeof CompressionStream !== "undefined") {
    bytes = await transformBytes(raw, new CompressionStream("gzip"));
    prefix = CODEC_GZIP_PREFIX;
  }
  const payload = prefix + bytesToBase64Url(bytes);
  if (payload.length > FRAGMENT_MAX_BYTES) {
    throw new Error(
      `doc-reviewer: refusing to encode: fragment payload is ${payload.length} bytes, over the ` +
      `${FRAGMENT_MAX_BYTES}-byte limit for URL fragments; use the #src= channel, a file, or a directory instead`,
    );
  }
  if (payload.length > FRAGMENT_WARN_BYTES) {
    console.warn(
      `doc-reviewer: fragment payload is ${Math.round(payload.length / 1024)} KB, above the ` +
      `${Math.round(FRAGMENT_WARN_BYTES / 1024)} KB warning threshold; browsers and chat apps truncate very long URLs`,
    );
  }
  return `#d=${payload}`;
}

export async function decodeFragment(value) {
  try {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error("payload is empty");
    }
    let payload = value;
    // Tolerate callers handing back the whole `#d=...` fragment verbatim.
    if (payload.startsWith("#") || /^(d|src)=/.test(payload)) {
      const parsed = parseHash(payload);
      if (!parsed || parsed.kind !== "envelope") {
        throw new Error("fragment does not carry an envelope payload");
      }
      payload = parsed.text;
    }
    let codec = null;
    if (payload.startsWith(CODEC_GZIP_PREFIX)) {
      codec = "gzip";
      payload = payload.slice(CODEC_GZIP_PREFIX.length);
    } else if (payload.startsWith(CODEC_RAW_PREFIX)) {
      codec = "raw";
      payload = payload.slice(CODEC_RAW_PREFIX.length);
    }
    const bytes = base64UrlToBytes(payload);
    if (codec === null) {
      codec = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? "gzip" : "raw";
    }
    let text;
    if (codec === "gzip") {
      if (typeof DecompressionStream === "undefined") {
        throw new Error("payload is gzip but DecompressionStream is unavailable in this environment");
      }
      text = new TextDecoder().decode(await transformBytes(bytes, new DecompressionStream("gzip")));
    } else {
      text = new TextDecoder().decode(bytes);
    }
    let result;
    try {
      result = JSON.parse(text);
    } catch (error) {
      throw new Error(`payload is not valid JSON (${describe(error)})`);
    }
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new Error("payload JSON must be an envelope object, not an array or scalar");
    }
    return result;
  } catch (error) {
    throw new Error(`doc-reviewer: cannot decode fragment payload: ${describe(error)}`);
  }
}
