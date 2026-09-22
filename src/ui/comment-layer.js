/**
 * Margin comment markers positioned over the document so the text layout never
 * shifts. Markers reveal their card on hover/focus; activation highlights the
 * anchored range; anchors that no longer resolve are flagged stale.
 */

function findTextRange(root, anchor) {
  if (!anchor || typeof anchor.quote !== "string" || !anchor.quote) return null;
  // Anchors captured against html source may carry tags; the visible text does not.
  const needle = anchor.quote.replace(/<[^>]+>/g, "");
  if (!needle) return null;
  const full = root.textContent ?? "";
  let from = 0;
  let found = -1;
  const wanted = Math.max(0, anchor.occurrence ?? 0);
  for (let seen = 0; seen <= wanted; seen += 1) {
    found = full.indexOf(needle, from);
    if (found === -1) return null;
    from = found + needle.length;
  }
  const start = found;
  const end = found + needle.length;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let position = 0;
  let started = false;
  let node;
  while ((node = walker.nextNode())) {
    const next = position + node.data.length;
    if (!started && start <= position + node.data.length && start >= position) {
      range.setStart(node, start - position);
      started = true;
    }
    if (started && end <= next) {
      range.setEnd(node, end - position);
      return range;
    }
    position = next;
  }
  return null;
}

function findElement(root, anchor) {
  if (!anchor || anchor.kind !== "element" || !anchor.selector) return null;
  try {
    return root.querySelector(anchor.selector);
  } catch {
    return null; // malformed selector from an older session still renders as stale
  }
}

let activeHighlightName = null;

function highlightRange(range) {
  if (!range) return;
  try {
    if (typeof Highlight !== "undefined" && window.CSS?.highlights) {
      if (activeHighlightName) window.CSS.highlights.delete(activeHighlightName);
      activeHighlightName = `dr-comment-${Date.now()}`;
      window.CSS.highlights.set(activeHighlightName, new Highlight(range));
      return;
    }
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // Highlighting is a convenience; failure must never block activation.
  }
}

function anchorRange(root, anchor) {
  const element = findElement(root, anchor);
  if (element) {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range;
  }
  return findTextRange(root, anchor);
}

function positionMarker(marker, range, element, layer) {
  const rect = range
    ? range.getClientRects()[0]
    : element
      ? element.getBoundingClientRect()
      : null;
  if (!rect) {
    marker.style.top = "4px"; // unresolved anchors stack at the top, visibly flagged
    return;
  }
  const layerRect = layer.getBoundingClientRect();
  marker.style.top = `${Math.max(0, rect.top - layerRect.top - 4)}px`;
}

/**
 * Render markers into `layer`. Options: { root, staleIds, onRemove, onActivate }.
 */
export function renderComments(layer, comments, options = {}) {
  const { root, staleIds, onRemove, onActivate } = options;
  layer.replaceChildren();
  comments.forEach((comment, index) => {
    const anchor = comment.anchor ?? {};
    const range = root ? anchorRange(root, anchor) : null;
    const element = root ? findElement(root, anchor) : null;
    const stale = (staleIds?.has(comment.id) ?? false) || (!range && !element);

    const marker = document.createElement("div");
    marker.className = stale ? "comment-marker is-stale" : "comment-marker";
    marker.dataset.commentId = comment.id;

    const dot = document.createElement("button");
    dot.className = "marker-dot";
    dot.type = "button";
    dot.textContent = String(index + 1);
    dot.setAttribute(
      "aria-label",
      `Comment ${index + 1}${stale ? " (stale)" : ""}: ${String(comment.body ?? "").slice(0, 60)}`,
    );

    const card = document.createElement("div");
    card.className = "comment-card";
    if (stale) {
      const flag = document.createElement("p");
      flag.className = "comment-stale";
      flag.textContent = "This anchor no longer resolves in the document.";
      card.append(flag);
    }
    const body = document.createElement("p");
    body.className = "comment-body";
    body.textContent = String(comment.body ?? "");
    const actions = document.createElement("div");
    actions.className = "comment-actions";
    const show = document.createElement("button");
    show.className = "button";
    show.type = "button";
    show.textContent = "Show";
    show.addEventListener("click", () => {
      const target = root ? anchorRange(root, anchor) : null;
      highlightRange(target);
      onActivate?.(comment, target);
    });
    const remove = document.createElement("button");
    remove.className = "button ghost danger";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => onRemove?.(comment.id));
    actions.append(show, remove);
    card.append(body, actions);
    marker.append(dot, card);

    positionMarker(marker, range, element, layer);
    layer.append(marker);
  });
}

/**
 * Floating composer for a new comment. Kept outside re-rendered containers so
 * state changes cannot destroy a half-typed body.
 */
export function showCommentComposer({ x, y, onSubmit, onCancel }) {
  const composer = document.createElement("div");
  composer.className = "composer";
  const input = document.createElement("textarea");
  input.className = "composer-input";
  input.maxLength = 8000;
  input.setAttribute("aria-label", "Comment body");
  input.placeholder = "Comment on this selection…";
  const actions = document.createElement("div");
  actions.className = "composer-actions";
  const cancel = document.createElement("button");
  cancel.className = "button ghost";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const save = document.createElement("button");
  save.className = "button primary";
  save.type = "button";
  save.textContent = "Add comment";

  const close = () => composer.remove();
  const submit = () => {
    const body = input.value.trim();
    if (!body) {
      input.focus();
      return;
    }
    close();
    onSubmit?.(body);
  };
  cancel.addEventListener("click", () => {
    close();
    onCancel?.();
  });
  save.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      onCancel?.();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      submit();
    }
  });
  actions.append(cancel, save);
  composer.append(input, actions);
  document.body.append(composer);

  const left = Math.max(8, Math.min(x, window.innerWidth - 316));
  const top = Math.max(8, Math.min(y, window.innerHeight - 180));
  composer.style.left = `${left}px`;
  composer.style.top = `${top}px`;
  input.focus();
  return close;
}
