/**
 * Allowlist sanitizer for envelope-supplied HTML.
 *
 * An envelope arrives from a language model and is rendered as HTML, so it is treated as
 * hostile: architecture.md invariant 1 says untrusted input reaches the DOM only through
 * `sanitizeHtml`. The policy functions below are pure and exported so they can be pinned
 * under `node --test` without a DOM; `sanitizeHtml` itself needs a real document and is
 * covered by the browser smoke test.
 */

export const ALLOWED_TAGS = [
  "p", "div", "span", "br", "hr", "em", "strong", "b", "i", "u", "s", "del", "ins",
  "mark", "small", "sub", "sup", "code", "pre", "blockquote", "ul", "ol", "li",
  "dl", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "figure", "figcaption", "a", "img",
];

export const SAFE_URL_SCHEMES = ["http", "https", "mailto", "tel"];

/**
 * Per-tag additions on top of the shared list. `class` and `id` are deliberately absent:
 * the document must not be able to reach into the app's own styling or scripting, and
 * dropping them also stops an envelope from impersonating app chrome.
 */
export const ALLOWED_ATTRS = {
  "*": ["title", "style"],
  a: ["href"],
  img: ["src", "alt"],
  ins: ["datetime", "cite"],
  del: ["datetime", "cite"],
  blockquote: ["cite"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
};

/** Tags removed together with their content. Live CSS joins the list because surviving
 * stylesheet rules can restyle or hide the whole page, and CSS text cannot be rewritten
 * as safely as element content can. */
const REMOVE_WITH_CONTENT = new Set([
  "script", "iframe", "object", "embed", "link", "meta", "base", "form", "style",
]);

const ALLOWED_TAG_SET = new Set(ALLOWED_TAGS);

/** CSS constructs that fetch, execute, or escape the document flow. */
const UNSAFE_STYLE = /url\s*\(|expression\s*\(|@import|javascript:|vbscript:|behavior\s*:|position\s*:\s*fixed/i;

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i;

/** Attributes that carry a URL and therefore need the scheme check. */
const URL_ATTRS = new Set(["href", "src", "cite", "action", "formaction", "poster", "srcset"]);

/**
 * Browsers ignore tabs, newlines, and control characters inside URLs, and legacy engines
 * ignored more, so collapse every whitespace and control character before looking for a
 * scheme. That makes `java\tscript:` and ` javascript:` fail here rather than in a parser
 * that is more permissive than this check.
 */
function collapse(value) {
  return String(value ?? "").replace(/[\s\u0000-\u001f\u007f]+/g, "").toLowerCase();
}

/** Pure. `true` means the URL is safe to place in an attribute. */
export function isSafeUrl(url) {
  const collapsed = collapse(url);
  // Empty, relative, fragment-only, and query-only URLs have no scheme to abuse.
  if (collapsed === "") return true;
  const match = /^([a-z][a-z0-9+.-]*):/.exec(collapsed);
  if (!match) return true;
  const scheme = match[1];
  if (scheme === "data") return DATA_IMAGE.test(collapsed);
  return SAFE_URL_SCHEMES.includes(scheme);
}

/** Pure. `true` means the tag survives; others are unwrapped, keeping their text. */
export function isAllowedTag(tagName) {
  return ALLOWED_TAG_SET.has(String(tagName ?? "").trim().toLowerCase());
}

/** Pure. `true` means the attribute survives on that tag. */
export function isAllowedAttribute(tagName, attrName, attrValue) {
  const tag = String(tagName ?? "").trim().toLowerCase();
  const name = String(attrName ?? "").trim().toLowerCase();
  if (name === "") return false;
  // Every event handler is refused by prefix rather than by a list, so a new handler
  // name added to the platform later is still refused.
  if (name.startsWith("on")) return false;
  if (name === "srcdoc") return false;
  if (name === "style") return !UNSAFE_STYLE.test(String(attrValue ?? ""));
  const allowed = ALLOWED_ATTRS[tag] ?? [];
  const shared = ALLOWED_ATTRS["*"] ?? [];
  if (!allowed.includes(name) && !shared.includes(name)) return false;
  if (URL_ATTRS.has(name)) return isSafeUrl(attrValue);
  return true;
}

/** Replace an element with its children so disallowed markup loses its tag but not its prose. */
function unwrap(element) {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

function scrub(node, doc) {
  for (const child of Array.from(node.childNodes)) {
    // Comments are dropped: they can carry conditional-comment payloads and have no
    // role in a document being reviewed.
    if (child.nodeType === 8) {
      node.removeChild(child);
      continue;
    }
    if (child.nodeType !== 1) continue;

    const tag = String(child.tagName ?? "").toLowerCase();
    if (REMOVE_WITH_CONTENT.has(tag)) {
      node.removeChild(child);
      continue;
    }
    if (!isAllowedTag(tag)) {
      unwrap(child);
      continue;
    }

    for (const attr of Array.from(child.attributes)) {
      if (!isAllowedAttribute(tag, attr.name, attr.value)) child.removeAttribute(attr.name);
    }
    // A surviving link must not be able to reach back through window.opener.
    if (tag === "a") child.setAttribute("rel", "noopener noreferrer");
    if (tag === "img" && !child.getAttribute("src")) unwrap(child);

    scrub(child, doc);
  }
}

/**
 * Sanitize untrusted markup and return an HTML string.
 *
 * A `<template>` is used because its content is parsed without loading subresources and
 * without executing anything, so nothing runs even before the walk begins.
 */
export function sanitizeHtml(html, options = {}) {
  const doc = options.document ?? globalThis.document;
  if (!doc || typeof doc.createElement !== "function") {
    throw new Error("sanitizeHtml requires a document (pass { document })");
  }
  const template = doc.createElement("template");
  template.innerHTML = String(html ?? "");
  scrub(template.content, doc);
  return template.innerHTML;
}
