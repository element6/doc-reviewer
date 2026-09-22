/**
 * File-drop channel: the AI exports an envelope@1 JSON file and the human drops it in.
 */

import { MAX_CONTENT_CHARS } from "../contract.js";

// Four times the contract's content cap fits a full doc.content plus a full replace
// proposal with room for ops and JSON escaping, while a stray multi-hundred-MB drop
// fails fast instead of freezing the tab.
export const MAX_ENVELOPE_FILE_BYTES = MAX_CONTENT_CHARS * 4;

export function isEnvelopeFile(file) {
  return Boolean(file) && typeof file.name === "string" && /\.json$/i.test(file.name);
}

export async function readEnvelopeFromFiles(files) {
  const list = files === null || files === undefined ? [] : Array.from(files);
  if (list.length === 0) {
    throw new Error('no file selected — drop or pick a .json envelope file exported by the AI');
  }
  const file = list.find(isEnvelopeFile);
  if (!file) {
    const names = list.slice(0, 3).map((entry) => (entry ? entry.name : null)).join(", ");
    throw new Error(`selection has no .json envelope file (saw: ${names || "unnamed entries"})`);
  }
  if (typeof file.size === "number" && file.size > MAX_ENVELOPE_FILE_BYTES) {
    throw new Error(`envelope file is ${file.size} bytes, over the ${MAX_ENVELOPE_FILE_BYTES}-byte limit`);
  }
  const text = await readText(file);
  if (text.trim().length === 0) {
    throw new Error(`envelope file "${file.name}" is empty`);
  }
  return text;
}

async function readText(file) {
  if (typeof file.text === "function") {
    try {
      return await file.text();
    } catch (error) {
      throw new Error(`cannot read "${file.name}": ${describe(error)}`);
    }
  }
  if (typeof FileReader === "undefined") {
    throw new Error(`cannot read "${file.name}": this environment has neither File.text() nor FileReader`);
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error(`cannot read "${file.name}": ${describe(reader.error)}`));
    reader.onabort = () => reject(new Error(`reading "${file.name}" was aborted`));
    reader.readAsText(file);
  });
}

function describe(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}
