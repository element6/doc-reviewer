/**
 * Review bar: hunk navigation, per-hunk and bulk decisions, undo/redo, and the
 * rendered/source toggle, plus global shortcuts. Keys are never hijacked while
 * the user is typing in a form field or contenteditable region.
 */

function button(label, { title, ariaLabel, primary, onPress, disabled, pressed } = {}) {
  const el = document.createElement("button");
  el.className = primary ? "button primary" : "button";
  el.type = "button";
  el.textContent = label;
  if (title) el.title = title;
  if (ariaLabel) el.setAttribute("aria-label", ariaLabel);
  if (disabled) el.disabled = true;
  if (pressed !== undefined) el.setAttribute("aria-pressed", String(pressed));
  el.addEventListener("click", onPress);
  return el;
}

function group(...children) {
  const el = document.createElement("div");
  el.className = "review-bar-group";
  for (const child of children) el.append(child);
  return el;
}

/**
 * view: { hunkCount, currentIndex, undecided, mode, canComment? }
 * handlers: { onPrev, onNext, onDecide, onDecideAll, onUndo, onRedo, onToggleMode, onComment }
 */
export function renderReviewBar(container, view, handlers = {}) {
  const { hunkCount, currentIndex, undecided, mode } = view;
  const hasCurrent = currentIndex >= 0 && currentIndex < hunkCount;
  container.replaceChildren();

  const counter = document.createElement("div");
  counter.className = "hunk-counter";
  counter.setAttribute("aria-live", "polite");
  counter.textContent = hunkCount === 0 ? "No hunks" : `${currentIndex + 1} / ${hunkCount} hunks`;
  if (undecided > 0) {
    const pending = document.createElement("span");
    pending.className = "undecided";
    pending.textContent = `${undecided} undecided`;
    counter.append(pending);
  }

  const hints = document.createElement("span");
  hints.className = "shortcut-hints";
  hints.innerHTML = ""; // text only: no markup from any source
  const hint = document.createElement("span");
  hint.innerHTML = "";
  hint.append("Shortcuts: ");
  for (const [key, action] of [["[", "prev"], ["]", "next"], ["a", "accept"], ["r", "reject"], ["c", "comment"]]) {
    const kbd = document.createElement("kbd");
    kbd.textContent = key;
    hints.append(kbd, document.createTextNode(` ${action} · `));
  }
  const undoKbd = document.createElement("kbd");
  undoKbd.textContent = "Ctrl/Cmd+Z";
  hints.append(undoKbd, document.createTextNode(" undo"));

  container.append(
    group(
      button("[", { title: "Previous hunk ([)", ariaLabel: "Previous hunk", onPress: handlers.onPrev, disabled: !hasCurrent || currentIndex === 0 }),
      counter,
      button("]", { title: "Next hunk (])", ariaLabel: "Next hunk", onPress: handlers.onNext, disabled: !hasCurrent || currentIndex >= hunkCount - 1 }),
    ),
    group(
      button("Accept", { title: "Accept current hunk (a)", onPress: () => handlers.onDecide?.("accepted"), disabled: !hasCurrent, pressed: false }),
      button("Reject", { title: "Reject current hunk (r)", onPress: () => handlers.onDecide?.("rejected"), disabled: !hasCurrent }),
      button("Accept all", { onPress: () => handlers.onDecideAll?.("accepted"), disabled: hunkCount === 0 }),
      button("Reject all", { onPress: () => handlers.onDecideAll?.("rejected"), disabled: hunkCount === 0 }),
    ),
    group(
      button("Comment", { title: "Comment on the current selection (c)", onPress: handlers.onComment }),
      button("Undo", { title: "Undo (Ctrl/Cmd+Z)", onPress: handlers.onUndo }),
      button("Redo", { title: "Redo (Shift+Ctrl/Cmd+Z)", onPress: handlers.onRedo }),
      button("Rendered", { title: "Show the rendered document", onPress: handlers.onToggleMode, pressed: mode === "rendered" }),
      button("Source", { title: "Show the raw source", onPress: handlers.onToggleMode, pressed: mode === "source" }),
    ),
    hints,
  );
}

function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("textarea, input, select, [contenteditable='true'], [contenteditable='']"));
}

/** Bind shortcuts once; `provide` returns the current handlers on each keypress. */
export function bindShortcuts(provide) {
  window.addEventListener("keydown", (event) => {
    if (isTypingTarget(event.target)) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === "z" || event.key === "Z")) {
      event.preventDefault();
      const handlers = provide();
      if (event.shiftKey) handlers.onRedo?.();
      else handlers.onUndo?.();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const handlers = provide();
    switch (event.key) {
      case "[":
        event.preventDefault();
        handlers.onPrev?.();
        break;
      case "]":
        event.preventDefault();
        handlers.onNext?.();
        break;
      case "a":
        if (!handlers.hasCurrent?.()) return;
        event.preventDefault();
        handlers.onDecideCurrent?.("accepted");
        break;
      case "r":
        if (!handlers.hasCurrent?.()) return;
        event.preventDefault();
        handlers.onDecideCurrent?.("rejected");
        break;
      case "c":
        event.preventDefault();
        handlers.onComment?.();
        break;
      default:
        break;
    }
  });
}
