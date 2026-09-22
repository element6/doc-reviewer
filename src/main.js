/**
 * Boot and wiring: inbound channels -> contract -> diff -> session -> UI, and
 * the feedback payload back out. Sessions are in-memory by design; a refresh
 * loses them, so an unload guard fires while hunks are undecided.
 */
import { parseEnvelope, applyProposal, describeFailure } from "./contract.js";
import { extractBlocks } from "./html-blocks.js";
import { hunksFromBlocks } from "./diff.js";
import {
  createSession, decide, decideAll, addComment, removeComment,
  setManualEdit, undo, redo, resultContent,
} from "./state.js";
import { isAnchorStale } from "./anchor.js";
import { sanitizeHtml } from "./sanitize.js";
import { parseHash, encodeEnvelope, decodeFragment } from "./channels/hash.js";
import { readEnvelopeFromFiles } from "./channels/file.js";
import { copyText, readText } from "./channels/clipboard.js";
import { isSupported as isFsSupported, pickDirectory, pollInbox, writeOutbox } from "./channels/fsaccess.js";
import { renderDocument, setMode, getMode, defaultModeFor } from "./ui/doc-view.js";
import { anchorFromRange, startElementPicker, initSelectionTracking, getStashedRange } from "./ui/selection.js";
import { renderComments, showCommentComposer } from "./ui/comment-layer.js";
import { renderReviewBar, bindShortcuts } from "./ui/review-bar.js";
import { renderFeedback, deriveVerdict, countUndecided } from "./ui/feedback-panel.js";

const $ = (id) => document.getElementById(id);

const els = {
  errorSurface: $("errorSurface"), errorList: $("errorList"), dismissError: $("dismissError"),
  notices: $("notices"), emptyState: $("emptyState"), pasteBox: $("pasteBox"),
  loadPaste: $("loadPaste"), blankFormat: $("blankFormat"), blankStart: $("blankStart"),
  pickFileButton: $("pickFileButton"), fileInput: $("fileInput"), exchangeButton: $("exchangeButton"),
  workspace: $("workspace"), docPanelMeta: $("docPanelMeta"),
  pickElementButton: $("pickElementButton"), shareLinkButton: $("shareLinkButton"),
  docWrap: $("docWrap"), commentLayer: $("commentLayer"), docContainer: $("docContainer"),
  reviewBar: $("reviewBar"), feedbackPanel: $("feedbackPanel"),
  docTitle: $("docTitle"), formatBadge: $("formatBadge"),
  revisionBadge: $("revisionBadge"), verdictBadge: $("verdictBadge"),
};

let session = null;
let currentIndex = -1;
let baseBlocks = [];
let propBlocks = [];
let stopPicker = null;
let exchangeHandle = null;
const dismissedNotices = new Set();

function showError(errors) {
  els.errorList.replaceChildren();
  for (const error of errors) {
    const item = document.createElement("li");
    item.textContent = `${error.path}: ${error.message}`;
    els.errorList.append(item);
  }
  els.errorSurface.hidden = false;
}

function clearError() {
  els.errorSurface.hidden = true;
  els.errorList.replaceChildren();
}

/**
 * Persistent notice keyed by `id` (summary, rationale, unapplied changes) so re-renders
 * do not resurrect dismissed content; transient notices use no id.
 */
function notice(kind, text, id = null) {
  if (id) {
    if (dismissedNotices.has(id)) return;
    const existing = els.notices.querySelector(`[data-notice-id="${id}"]`);
    if (existing) return;
  }
  const box = document.createElement("div");
  box.className = `notice notice-${kind}`;
  if (id) box.dataset.noticeId = id;
  const body = document.createElement("div");
  body.className = "notice-body";
  body.textContent = text;
  const dismiss = document.createElement("button");
  dismiss.className = "button ghost";
  dismiss.type = "button";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => {
    if (id) dismissedNotices.add(id);
    box.remove();
  });
  box.append(body, dismiss);
  els.notices.append(box);
}

const getHunks = () => session?.hunks ?? [];
const currentHunk = () => getHunks()[currentIndex] ?? null;

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function scrollIntoCurrentHunk() {
  const hunk = currentHunk();
  if (!hunk) return;
  const card = els.docContainer.querySelector(`[data-hunk-id="${cssEscape(hunk.id)}"]`);
  if (!card) return;
  card.focus({ preventScroll: true });
  card.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
}

function cssEscape(value) {
  // Attribute-selector values only need quotes/backslashes escaped, not CSS.escape.
  return String(value).replace(/["\\]/g, "\\$&");
}

function computeStaleIds() {
  const stale = new Set();
  if (!session) return stale;
  let result = "";
  let proposed = session.proposedContent ?? "";
  try {
    result = resultContent(session);
  } catch {
    return stale;
  }
  for (const comment of session.comments ?? []) {
    try {
      // Stale only when the quote resolves in neither the current result nor
      // the proposed text: anchors on pending additions must not flash stale.
      if (isAnchorStale(result, comment.anchor) && isAnchorStale(proposed, comment.anchor)) {
        stale.add(comment.id);
      }
    } catch {
      // An anchor form this build cannot check is treated as resolvable.
    }
  }
  return stale;
}

function update(next) {
  if (next && next !== session) session = next;
  render();
}

function gotoHunk(delta) {
  const hunks = getHunks();
  if (hunks.length === 0) return;
  const next = Math.min(Math.max(currentIndex + delta, 0), hunks.length - 1);
  if (next === currentIndex) return;
  currentIndex = next;
  render();
  scrollIntoCurrentHunk();
}

function decideCurrent(decision) {
  const hunk = currentHunk();
  if (!hunk) return;
  update(decide(session, hunk.id, decision));
}

function render() {
  if (!session) {
    els.emptyState.hidden = false;
    els.workspace.hidden = true;
    els.docTitle.textContent = "No document loaded";
    els.formatBadge.hidden = true;
    els.revisionBadge.hidden = true;
    els.verdictBadge.hidden = true;
    return;
  }
  els.emptyState.hidden = true;
  els.workspace.hidden = false;

  const envelope = session.envelope;
  const hunks = getHunks();
  const undecided = countUndecided(session);
  const verdict = deriveVerdict(session);

  els.docTitle.textContent = envelope.doc.title;
  els.formatBadge.hidden = false;
  els.formatBadge.textContent = envelope.doc.format.toUpperCase();
  els.revisionBadge.hidden = false;
  els.revisionBadge.textContent = `r${envelope.doc.revision}`;
  els.verdictBadge.hidden = false;
  els.verdictBadge.textContent = undecided > 0 ? `${verdict} · ${undecided} undecided` : verdict;
  els.verdictBadge.classList.toggle("is-pending", undecided > 0 || verdict !== "accepted");
  els.docPanelMeta.textContent =
    `${envelope.doc.id} · request ${envelope.requestId} · ${hunks.length} hunks · ${session.comments?.length ?? 0} comments`;

  if (currentIndex >= hunks.length) currentIndex = hunks.length - 1;

  const scrollY = window.scrollY;
  renderDocument({
    session,
    mode: getMode(),
    container: els.docContainer,
    sanitizeHtml: (html) => sanitizeHtml(html, { document }),
    handlers: {
      onDecide: (id, decision) => update(decide(session, id, decision)),
      onSourceChange: applySourceEdit,
      currentId: currentHunk()?.id,
    },
    currentId: currentHunk()?.id,
  });
  renderComments(els.commentLayer, session.comments ?? [], {
    root: els.docContainer,
    staleIds: computeStaleIds(),
    onRemove: (id) => update(removeComment(session, id)),
    onActivate: (comment) => {
      const blockId = comment.anchor?.blockId;
      if (!blockId) return;
      const block = els.docContainer.querySelector(`[data-dr-block="${cssEscape(blockId)}"]`);
      block?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
    },
  });
  renderReviewBar(els.reviewBar, {
    hunkCount: hunks.length,
    currentIndex,
    undecided,
    mode: getMode(),
  }, {
    onPrev: () => gotoHunk(-1),
    onNext: () => gotoHunk(1),
    onDecide: (decision) => decideCurrent(decision),
    onDecideAll: (decision) => update(decideAll(session, decision)),
    onUndo: () => {
      try { update(undo(session)); } catch (error) { notice("warning", `Undo failed: ${error?.message ?? error}`); }
    },
    onRedo: () => {
      try { update(redo(session)); } catch (error) { notice("warning", `Redo failed: ${error?.message ?? error}`); }
    },
    onToggleMode: () => {
      setMode(getMode() === "rendered" ? "source" : "rendered");
      render();
    },
    onComment: startComment,
  });
  renderFeedback(els.feedbackPanel, session, {
    onCopy: async (text) => {
      try {
        const ok = await copyText(text);
        return ok === true ? { ok: true } : { reason: "clipboard permission denied or unavailable" };
      } catch (error) {
        return { reason: error?.message ?? String(error) };
      }
    },
    onDownload: (text, name) => downloadText(name, text),
    onWriteOutbox: exchangeHandle
      ? async (text) => {
          try {
            await writeOutbox(exchangeHandle, `feedback-${session.envelope.requestId}.json`, text);
            return { ok: true };
          } catch (error) {
            return { reason: error?.message ?? String(error) };
          }
        }
      : undefined,
  });

  window.scrollTo(0, scrollY);
}

function downloadText(name, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return true;
}

/**
 * Source-mode save: express the edit as per-block setManualEdit calls over the
 * minimal changed region (partition invariant makes block spans exact).
 */
function applySourceEdit(text) {
  if (!session) return;
  const format = session.envelope.doc.format;
  const current = resultContent(session);
  if (text === current) return;
  let prefix = 0;
  const maxPrefix = Math.min(current.length, text.length);
  while (prefix < maxPrefix && current[prefix] === text[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = Math.min(current.length - prefix, text.length - prefix);
  while (suffix < maxSuffix && current[current.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix += 1;
  const oldEnd = current.length - suffix;
  const newRegion = text.slice(prefix, text.length - suffix);
  if (oldEnd === prefix && newRegion === "") return;

  const blocks = extractBlocks(current, format);
  const starts = [];
  let acc = 0;
  for (const block of blocks) {
    starts.push(acc);
    acc += block.html.length;
  }
  let first = -1;
  let last = -1;
  blocks.forEach((block, index) => {
    const start = starts[index];
    const end = start + block.html.length;
    if (end > prefix && start < oldEnd) {
      if (first === -1) first = index;
      last = index;
    }
  });
  if (first === -1) {
    notice("warning", "Source edit could not be mapped onto document blocks; nothing was saved.");
    return;
  }
  const head = blocks[first].html.slice(0, Math.max(0, prefix - starts[first]));
  const tail = blocks[last].html.slice(Math.max(0, oldEnd - starts[last]));
  const edits = [[blocks[first].blockId, head + newRegion + tail]];
  for (let index = first + 1; index <= last; index += 1) {
    edits.push([blocks[index].blockId, ""]);
  }
  try {
    let next = session;
    for (const [blockId, html] of edits) next = setManualEdit(next, blockId, html);
    session = next;
    notice("success", "Source saved. Hunk decisions were kept.");
    render();
  } catch (error) {
    notice("error", `Source edit failed: ${error?.message ?? error}`);
  }
}

function anchorContext() {
  return {
    root: els.docContainer,
    format: session.envelope.doc.format,
    baseBlocks,
    propBlocks,
    baseText: session.envelope.doc.content,
    proposedText: session.proposedContent,
  };
}

function openComposer(anchor, rect) {
  const x = rect ? rect.left : window.innerWidth / 2 - 150;
  const y = rect ? rect.bottom + 8 : window.innerHeight / 2 - 80;
  showCommentComposer({
    x,
    y,
    onSubmit: (body) => {
      update(addComment(session, anchor, body));
      notice("success", "Comment added.");
    },
  });
}

function startComment() {
  if (!session) return;
  const selection = window.getSelection();
  let range = null;
  let liveOutside = false;
  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    const live = selection.getRangeAt(0);
    if (els.docContainer.contains(live.commonAncestorContainer)) range = live;
    else liveOutside = true;
  }
  if (!range) {
    // Clicking Comment collapses the live selection; fall back to the last
    // real selection inside the document (controls never clear the stash).
    const stashed = getStashedRange();
    if (stashed && !stashed.collapsed && els.docContainer.contains(stashed.commonAncestorContainer)) {
      range = stashed;
    }
  }
  if (!range) {
    if (liveOutside) notice("warning", "That selection is outside the document.");
    else notice("warning", "Select text in the document, then press c or click Comment.");
    return;
  }
  const anchor = anchorFromRange(range, anchorContext());
  if (!anchor) {
    notice("warning", "Could not map that selection to document source; try selecting within a single block.");
    return;
  }
  openComposer(anchor, range.getBoundingClientRect());
}

function togglePicker() {
  if (stopPicker) {
    stopPicker();
    stopPicker = null;
    els.pickElementButton.setAttribute("aria-pressed", "false");
    return;
  }
  stopPicker = startElementPicker({
    root: els.docContainer,
    context: anchorContext(),
    onPick: (anchor, rect) => {
      stopPicker = null;
      els.pickElementButton.setAttribute("aria-pressed", "false");
      openComposer(anchor, rect);
    },
    onCancel: () => {
      stopPicker = null;
      els.pickElementButton.setAttribute("aria-pressed", "false");
    },
  });
  els.pickElementButton.setAttribute("aria-pressed", "true");
}

function emitProposalNotices(envelope, opResults, warnings) {
  if (warnings?.length) notice("warning", `Ignored unknown fields: ${warnings.join("; ")}`, "warnings");
  if (envelope.proposal.summary) notice("info", `Proposed change: ${envelope.proposal.summary}`, "summary");
  if (envelope.proposal.rationale) notice("info", `Rationale: ${envelope.proposal.rationale}`, "rationale");
  const failed = (opResults ?? []).filter((result) => result.status !== "applied");
  if (failed.length > 0) {
    const lines = failed.map(describeFailure);
    notice("error", `${failed.length} proposed change(s) did not apply: ${lines.join("; ")}. Those changes did not land.`, "unapplied");
  }
}

function startSession(envelope, warnings = []) {
  const { content: proposedContent, opResults } = applyProposal(envelope.doc, envelope.proposal);
  baseBlocks = extractBlocks(envelope.doc.content, envelope.doc.format);
  propBlocks = extractBlocks(proposedContent, envelope.doc.format);
  let hunks = [];
  let diffFailure = null;
  try {
    const diff = hunksFromBlocks(baseBlocks, propBlocks);
    if (diff.ok) hunks = diff.hunks;
    else diffFailure = diff.reason ?? "unknown reason";
  } catch (error) {
    diffFailure = error?.message ?? String(error);
  }
  session = createSession({ envelope, proposedContent, hunks, opResults });
  currentIndex = hunks.length > 0 ? 0 : -1;
  setMode(defaultModeFor(envelope.doc.format));
  clearError();
  if (diffFailure) {
    showError([{ path: "$.proposal", message: `diff could not be computed: ${diffFailure}; the document is shown without a diff` }]);
  }
  emitProposalNotices(envelope, opResults, warnings);
  render();
}

function loadEnvelopeInput(input) {
  const parsed = parseEnvelope(input);
  if (!parsed.ok) {
    showError(parsed.errors);
    return false;
  }
  startSession(parsed.envelope, parsed.warnings);
  return true;
}

async function loadFiles(files) {
  if (!files || files.length === 0) return;
  try {
    const text = await readEnvelopeFromFiles(files);
    loadEnvelopeInput(text);
  } catch (error) {
    showError([{ path: "$", message: `could not read the dropped file: ${error?.message ?? error}` }]);
  }
}

async function materializeHashPayload(text) {
  try {
    return await decodeFragment(text);
  } catch {
    // Not a compressed fragment: plain JSON in the link is also accepted.
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function bootFromHash() {
  const parsed = parseHash(location.hash);
  if (!parsed) return;
  if (parsed.kind === "envelope") {
    const data = await materializeHashPayload(parsed.text);
    if (data === null) {
      showError([{ path: "$", message: "the #d= link payload could not be decoded" }]);
      return;
    }
    loadEnvelopeInput(data);
    return;
  }
  if (parsed.kind === "url") {
    try {
      const response = await fetch(parsed.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (!loadEnvelopeInput(text)) {
        notice("warning", `The document at ${parsed.url} is not a valid envelope; paste it below instead.`);
      }
    } catch (error) {
      notice("warning", `Could not fetch ${parsed.url}: ${error?.message ?? error}. Paste the envelope below instead.`);
    }
  }
}

function startBlankDocument() {
  const format = els.blankFormat.value;
  const candidate = {
    schema: "doc-reviewer/envelope@1",
    requestId: crypto.randomUUID ? crypto.randomUUID() : `local-${Date.now()}`,
    doc: { id: `blank-${Date.now()}`, title: "Untitled document", format, revision: 1, content: "" },
    proposal: { kind: "replace", content: "" },
    options: { allowDirectEdit: true },
  };
  loadEnvelopeInput(JSON.stringify(candidate));
}

async function copyShareLink() {
  if (!session) return;
  try {
    const encoded = await encodeEnvelope(session.envelope);
    const url = `${location.origin}${location.pathname}#d=${encoded}`;
    const copied = await copyText(url);
    if (copied === true) {
      notice("success", "Share link copied to the clipboard.");
    } else {
      notice("warning", `Could not copy to the clipboard. Share link: ${url}`);
    }
  } catch (error) {
    notice("warning", `Could not encode a share link: ${error?.message ?? error}. This browser may lack CompressionStream.`);
  }
}

async function connectExchange() {
  if (!session && !exchangeHandle) {
    // Exchange is an inbound channel; available before any document loads.
  }
  try {
    const handle = await pickDirectory();
    exchangeHandle = handle;
    notice("success", `Watching ${handle.name ?? "the exchange directory"} for envelopes in its inbox.`);
    pollInbox(handle, (envelopeInput) => {
      loadEnvelopeInput(envelopeInput);
    });
    render();
  } catch (error) {
    notice("warning", `Exchange directory unavailable: ${error?.message ?? error}`);
  }
}

function wireChannels() {
  els.loadPaste.addEventListener("click", () => {
    const text = els.pasteBox.value.trim();
    if (!text) {
      showError([{ path: "$", message: "paste an envelope first" }]);
      return;
    }
    loadEnvelopeInput(text);
  });
  els.pasteBox.addEventListener("paste", () => {
    window.setTimeout(() => {
      const text = els.pasteBox.value.trim();
      if (text.startsWith("{")) loadEnvelopeInput(text);
    }, 0);
  });
  els.pickFileButton.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => loadFiles(els.fileInput.files));
  els.blankStart.addEventListener("click", startBlankDocument);

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    document.body.classList.add("is-dragging");
  });
  window.addEventListener("dragleave", (event) => {
    if (event.target === document.documentElement || event.relatedTarget === null) {
      document.body.classList.remove("is-dragging");
    }
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    document.body.classList.remove("is-dragging");
    loadFiles(event.dataTransfer?.files);
  });

  if (isFsSupported()) {
    els.exchangeButton.hidden = false;
    els.exchangeButton.addEventListener("click", connectExchange);
  }
}

function wireActions() {
  els.dismissError.addEventListener("click", clearError);
  els.pickElementButton.setAttribute("aria-pressed", "false");
  els.pickElementButton.addEventListener("click", togglePicker);
  els.shareLinkButton.addEventListener("click", copyShareLink);
  // Preventing the mousedown default keeps the text selection intact when a
  // control is clicked, so commenting does not depend on the stash alone.
  for (const control of [els.pickElementButton, els.reviewBar]) {
    control.addEventListener("mousedown", (event) => {
      if (event.target instanceof Element && event.target.closest("button")) event.preventDefault();
    });
  }
  initSelectionTracking({ root: els.docContainer, onComment: startComment });
}

function wireUnloadGuard() {
  window.addEventListener("beforeunload", (event) => {
    if (session && countUndecided(session) > 0) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}

bindShortcuts(() => ({
  onPrev: () => gotoHunk(-1),
  onNext: () => gotoHunk(1),
  hasCurrent: () => currentHunk() !== null,
  onDecideCurrent: (decision) => decideCurrent(decision),
  onComment: startComment,
  onUndo: () => { try { update(undo(session)); } catch { /* reported by review-bar path */ } },
  onRedo: () => { try { update(redo(session)); } catch { /* reported by review-bar path */ } },
}));

// readText backs a best-effort paste button behaviour for browsers where the
// textarea paste gesture is unavailable; failure keeps the manual path.
void readText;

wireChannels();
wireActions();
wireUnloadGuard();
bootFromHash();
render();
