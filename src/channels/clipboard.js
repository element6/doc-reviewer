/**
 * Clipboard channel. copyText never throws: when every route fails it resolves to
 * false so the caller can render a visible reason (architecture.md: no caller may
 * assume success). Importing this module outside a browser is safe.
 */

export async function copyText(text) {
  const value = String(text ?? "");
  if (canUse("writeText")) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Denied or busy: fall through to the textarea route.
    }
  }
  return copyViaTextarea(value);
}

export async function readText() {
  // No browser offers a paste fallback outside the async API, so absence and denial
  // both degrade to the empty string — a value the caller already handles.
  if (canUse("readText")) {
    try {
      const value = await navigator.clipboard.readText();
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }
  return "";
}

function canUse(method) {
  if (typeof isSecureContext !== "undefined" && isSecureContext !== true) return false;
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  return typeof navigator.clipboard[method] === "function";
}

function copyViaTextarea(value) {
  if (typeof document === "undefined" || !document.body || typeof document.execCommand !== "function") {
    return false;
  }
  let textarea = null;
  try {
    textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    // Fixed and transparent rather than display:none: some browsers refuse to select
    // an element they consider hidden.
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    return document.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    if (textarea && typeof textarea.remove === "function") textarea.remove();
  }
}
