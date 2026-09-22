/**
 * Directory channel over the Chromium-only File System Access API. Every entry point
 * degrades with a descriptive error instead of leaking a low-level DOMException, and
 * no caller may assume success (architecture.md).
 */

import { isEnvelopeFile } from "./file.js";

export function isSupported() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export async function pickDirectory() {
  if (!isSupported()) {
    throw new Error(
      "the File System Access API is unavailable — use Chrome or Edge over https:// or http://127.0.0.1",
    );
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error("directory selection was cancelled");
    throw new Error(`cannot open a directory: ${describe(error)}`);
  }
  if (typeof handle.requestPermission === "function") {
    let decision;
    try {
      decision = await handle.requestPermission({ mode: "readwrite" });
    } catch (error) {
      throw new Error(`cannot request write permission for "${handle.name}": ${describe(error)}`);
    }
    if (decision !== "granted") {
      throw new Error(
        `write permission for "${handle.name}" was denied — allow read/write access to use the directory channel`,
      );
    }
  }
  return handle;
}

/**
 * Polls `<root>/inbox` every `options.intervalMs` (default 2000) and calls
 * `onEnvelope(text, name)` exactly once per newly seen .json file — seen names are
 * recorded before delivery, so a failing callback never causes a redelivery loop.
 * Returns a stop function. Problems reach `options.onError`, defaulting to
 * console.error; a missing inbox folder is reported as prose, not NotFoundError.
 */
export function pollInbox(handle, onEnvelope, options = {}) {
  if (!isSupported()) {
    throw new Error(
      "the File System Access API is unavailable — use Chrome or Edge over https:// or http://127.0.0.1",
    );
  }
  if (!handle || typeof handle.getDirectory !== "function") {
    throw new Error("pollInbox needs a directory handle from pickDirectory()");
  }
  if (typeof onEnvelope !== "function") {
    throw new Error("pollInbox needs an onEnvelope callback");
  }
  const intervalMs =
    typeof options.intervalMs === "number" && Number.isFinite(options.intervalMs) && options.intervalMs > 0
      ? options.intervalMs
      : 2000;
  const report =
    typeof options.onError === "function"
      ? options.onError
      : (error) => console.error(`doc-reviewer inbox: ${error.message}`);
  const seen = new Set();
  let stopped = false;
  let busy = false;
  let lastError = "";

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      const inbox = await openInbox();
      for await (const [name, entry] of inbox.entries()) {
        if (stopped) break;
        if (entry.kind !== "file" || seen.has(name) || !isEnvelopeFile({ name })) continue;
        seen.add(name);
        try {
          const file = await entry.getFile();
          await onEnvelope(await file.text(), name);
        } catch (error) {
          report(new Error(`cannot deliver inbox envelope "${name}": ${describe(error)}`));
        }
      }
      lastError = "";
    } catch (error) {
      const messageText = describe(error);
      if (messageText !== lastError) {
        lastError = messageText;
        report(error instanceof Error ? error : new Error(messageText));
      }
    } finally {
      busy = false;
    }
  }

  async function openInbox() {
    try {
      return await handle.getDirectory("inbox", { create: false });
    } catch (error) {
      if (error && error.name === "NotFoundError") {
        throw new Error(
          `the selected directory has no "inbox" folder — create an inbox/ subdirectory and drop envelope files into it`,
        );
      }
      if (error && error.name === "NotAllowedError") {
        throw new Error(`read permission for the selected directory was revoked — re-grant it to keep polling`);
      }
      throw new Error(`cannot open inbox/: ${describe(error)}`);
    }
  }

  tick();
  const timer = setInterval(tick, intervalMs);
  return function stop() {
    stopped = true;
    clearInterval(timer);
  };
}

export async function writeOutbox(handle, name, text) {
  if (!isSupported()) {
    throw new Error(
      "the File System Access API is unavailable — use Chrome or Edge over https:// or http://127.0.0.1",
    );
  }
  if (!handle || typeof handle.getDirectory !== "function") {
    throw new Error("writeOutbox needs a directory handle from pickDirectory()");
  }
  if (typeof name !== "string" || name.trim() === "" || /[\\/]/.test(name) || name === "." || name === "..") {
    throw new Error(`invalid outbox file name ${JSON.stringify(String(name))} — pass a bare file name, not a path`);
  }
  if (typeof text !== "string") {
    throw new Error(`outbox content for "${name}" must be a string`);
  }
  let outbox;
  try {
    outbox = await handle.getDirectory("outbox", { create: true });
  } catch (error) {
    throw new Error(`cannot create the "outbox" folder in the selected directory: ${describe(error)}`);
  }
  let fileHandle;
  try {
    fileHandle = await outbox.getFileHandle(name, { create: true });
  } catch (error) {
    throw new Error(`cannot create outbox/${name}: ${describe(error)}`);
  }
  let writer;
  try {
    writer = await fileHandle.createWritable();
    await writer.write(text);
    await writer.close();
  } catch (error) {
    if (writer) {
      try {
        await writer.abort();
      } catch {
        // The stream already failed; aborting is best-effort cleanup.
      }
    }
    if (error && error.name === "NotAllowedError") {
      throw new Error(`cannot write outbox/${name}: write permission is missing or was revoked — re-grant read/write access`);
    }
    throw new Error(`cannot write outbox/${name}: ${describe(error)}`);
  }
}

function describe(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}
