/**
 * Feedback panel: a human-readable review summary beside the exact JSON
 * payload, with copy/download (and optional exchange outbox) transport. The
 * panel always states when hunks remain undecided, because those travel back
 * as "unresolved".
 */
import { buildFeedbackPayload } from "../state.js";
import { validateFeedback } from "../contract.js";

/**
 * Decisions are authoritative in `session.decisions`, keyed by hunk id (architecture.md);
 * a decision stored on the hunk itself is only a fallback. Reading `hunk.decision` alone
 * silently reported every hunk as unresolved, which then corrupted the verdict.
 */
export function hunkDecisionOf(hunk, session) {
  const stored = session?.decisions;
  const fromSession = stored instanceof Map ? stored.get(hunk.id) : stored?.[hunk.id];
  return fromSession ?? hunk.decision ?? "unresolved";
}

export function countUndecided(session) {
  return (session?.hunks ?? []).filter((hunk) => hunkDecisionOf(hunk, session) === "unresolved").length;
}

/**
 * The verdict is computed once, in `state.js`, and read back out of the payload, so the
 * badge on screen and the JSON handed to the AI cannot disagree.
 */
export function deriveVerdict(session) {
  return buildFeedbackPayload(session).verdict;
}

function decisionCounts(hunks, session) {
  const counts = { accepted: 0, rejected: 0, edited: 0, unresolved: 0 };
  for (const hunk of hunks) {
    const decision = hunkDecisionOf(hunk, session);
    counts[decision] = (counts[decision] ?? 0) + 1;
  }
  return counts;
}

function excerpt(text, limit = 70) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 3)}...` : flat;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderFeedback(panel, session, handlers = {}) {
  const { onCopy, onDownload, onWriteOutbox } = handlers;
  panel.replaceChildren();
  if (!session) return;

  const hunks = session.hunks ?? [];
  const comments = session.comments ?? [];
  const undecided = countUndecided(session);
  const verdict = deriveVerdict(session);
  const counts = decisionCounts(hunks, session);

  const summary = el("div", "feedback-summary");
  const verdictLine = el("span");
  verdictLine.append("Verdict: ");
  verdictLine.append(el("strong", verdict === "accepted" ? "verdict" : "verdict pending", verdict));
  const hunkLine = el("span", null,
    `Hunks: ${counts.accepted} accepted · ${counts.rejected} rejected · ${counts.edited} edited · ${counts.unresolved} undecided`);
  const commentLine = el("span", null, `Comments: ${comments.length}`);
  summary.append(verdictLine, hunkLine, commentLine);
  panel.append(summary);

  if (undecided > 0) {
    const notice = el("div", "notice visible");
    notice.append(el("div", "notice-body", null));
    notice.firstChild.textContent =
      `${undecided} of ${hunks.length} hunks are still undecided. They will be sent back as "unresolved" — decide them, or send now and let the AI propose again.`;
    panel.append(notice);
  }

  if (hunks.length > 0) {
    const list = el("ul", "feedback-hunks");
    for (const hunk of hunks) {
      const item = el("li");
      item.append(el("span", "decision-badge", hunkDecisionOf(hunk, session)));
      item.append(el("span", "feedback-excerpt", excerpt(hunk.baseText)));
      item.append(el("span", "feedback-excerpt", "→"));
      item.append(el("span", "feedback-excerpt", excerpt(hunk.proposedText)));
      list.append(item);
    }
    panel.append(list);
  }

  if (comments.length > 0) {
    const list = el("ul", "feedback-comments");
    for (const comment of comments) {
      const item = el("li");
      const label = comment.anchor?.label ?? comment.anchor?.blockId ?? comment.anchor?.kind ?? "selection";
      const marker = el("span", "decision-badge", "comment");
      const body = el("span", "feedback-excerpt", null);
      body.textContent = `${comment.body} — on ${label}`;
      item.append(marker, body);
      list.append(item);
    }
    panel.append(list);
  }

  const payload = buildFeedbackPayload(session);
  const text = JSON.stringify(payload, null, 2);

  const actions = el("div", "feedback-actions");
  const status = el("p", "feedback-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const setStatus = (message, kind) => {
    status.textContent = message;
    status.className = kind ? `feedback-status ${kind}` : "feedback-status";
  };

  const jsonArea = el("textarea", "json-area");
  jsonArea.readOnly = true;
  jsonArea.spellcheck = false;
  jsonArea.value = text;
  jsonArea.setAttribute("aria-label", "Feedback payload JSON");

  const details = document.createElement("details");
  details.className = "json-details";
  const summaryEl = el("summary", null, "Payload JSON");
  details.append(summaryEl, jsonArea);

  const copyButton = el("button", "button primary", "Copy for AI");
  copyButton.type = "button";
  copyButton.addEventListener("click", async () => {
    const check = validateFeedback(payload);
    if (!check.ok) {
      const first = check.errors.slice(0, 3).map((error) => `${error.path}: ${error.message}`).join("; ");
      setStatus(`Payload failed validation: ${first}`, "bad");
      return;
    }
    if (!onCopy) {
      setStatus("Copy handler unavailable.", "bad");
      return;
    }
    let result;
    try {
      result = await onCopy(text);
    } catch (error) {
      result = { reason: error?.message ?? String(error) };
    }
    if (result === true || result?.ok) {
      setStatus("Copied to clipboard.", "ok");
    } else {
      const reason = typeof result === "string" ? result : (result?.reason ?? "clipboard unavailable");
      details.open = true;
      jsonArea.select();
      setStatus(`Copy failed: ${reason}. The JSON is selected above — press Ctrl/Cmd+C.`, "bad");
    }
  });

  const downloadButton = el("button", "button", "Download feedback.dr.json");
  downloadButton.type = "button";
  downloadButton.addEventListener("click", async () => {
    if (!onDownload) {
      setStatus("Download handler unavailable.", "bad");
      return;
    }
    try {
      await onDownload(text, "feedback.dr.json");
      setStatus("Downloaded feedback.dr.json.", "ok");
    } catch (error) {
      setStatus(`Download failed: ${error?.message ?? error}`, "bad");
    }
  });

  actions.append(copyButton, downloadButton);
  if (onWriteOutbox) {
    const outboxButton = el("button", "button", "Write to exchange outbox");
    outboxButton.type = "button";
    outboxButton.addEventListener("click", async () => {
      try {
        const result = await onWriteOutbox(text);
        if (result === true || result?.ok) setStatus("Written to the exchange outbox.", "ok");
        else setStatus(`Outbox write failed: ${result?.reason ?? "unknown reason"}`, "bad");
      } catch (error) {
        setStatus(`Outbox write failed: ${error?.message ?? error}`, "bad");
      }
    });
    actions.append(outboxButton);
  }

  panel.append(actions, details, status);
}
