/**
 * Hunk rendering in writer's red/green vocabulary (writer/index.html:245-288):
 * keep -> text node, remove -> <del>, add -> <ins>, adjacent remove+add stacked
 * inside one inline-grid .diff-replacement. Elements are built with createElement
 * so untrusted diff text is never parsed as markup.
 */

function createSegment(part) {
  const element = document.createElement(part.type === "remove" ? "del" : "ins");
  element.setAttribute("aria-label", `${part.type === "remove" ? "Removed" : "Added"}: ${part.text}`);
  element.textContent = part.text;
  return element;
}

function appendSegment(frag, part, index, parts) {
  if (!part.text) return index;
  if (part.type === "keep") {
    frag.append(document.createTextNode(part.text));
    return index;
  }
  const next = parts[index + 1];
  if (part.type === "remove" && next && next.type === "add" && next.text) {
    // Writer appends added before removed (writer/index.html:281), so the new text
    // sits above the old text it replaces. Matching that order is the requested parity.
    const replacement = document.createElement("span");
    replacement.className = "diff-replacement";
    replacement.append(createSegment(next), createSegment(part));
    frag.append(replacement);
    return index + 1;
  }
  frag.append(createSegment(part));
  return index;
}

/**
 * Build the inline diff for one hunk. `parts === null` means the diff engine
 * refused an oversized diff; the hunk then degrades to a whole-block
 * removed/added pair plus `options.note`, never a blank space.
 */
export function renderHunkParts(parts, options = {}) {
  const frag = document.createDocumentFragment();
  let effective = parts;
  if (!Array.isArray(effective)) {
    effective = [];
    if (options.baseText) effective.push({ type: "remove", text: options.baseText });
    if (options.proposedText) effective.push({ type: "add", text: options.proposedText });
  }
  for (let index = 0; index < effective.length; index += 1) {
    index = appendSegment(frag, effective[index], index, effective);
  }
  if (options.note) {
    const note = document.createElement("p");
    note.className = "hunk-note";
    note.textContent = options.note;
    frag.append(note);
  }
  return frag;
}

function resolveDecision(decisions, hunk, index) {
  if (decisions instanceof Map) return decisions.get(hunk.id);
  if (Array.isArray(decisions)) return decisions[index];
  if (decisions && typeof decisions === "object") return decisions[hunk.id];
  return undefined;
}

function gutterButton(label, ariaLabel, onPick) {
  const button = document.createElement("button");
  button.className = "button";
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-label", ariaLabel);
  button.addEventListener("click", onPick);
  return button;
}

/**
 * Render hunks into `container` with a per-hunk gutter. `decisions` may be a
 * Map, a plain object keyed by hunk id, or an array aligned with `hunks`;
 * `handlers` takes { onDecide(id, decision), currentId }.
 */
export function renderHunks(hunks, decisions, container, handlers = {}) {
  container.replaceChildren();
  hunks.forEach((hunk, index) => {
    const decision = resolveDecision(decisions, hunk, index) ?? hunk.decision ?? "unresolved";
    const card = document.createElement("article");
    card.className = `hunk is-${decision}`;
    card.dataset.hunkId = hunk.id;
    card.tabIndex = -1;
    card.setAttribute(
      "aria-label",
      `Hunk ${index + 1} of ${hunks.length}, ${hunk.kind}, ${decision}`,
    );
    if (handlers.currentId === hunk.id) {
      card.classList.add("is-current");
      card.setAttribute("aria-current", "true");
    }

    const gutter = document.createElement("div");
    gutter.className = "hunk-gutter";
    // Non-colour marker: the diff stays readable without colour perception.
    const sign = document.createElement("span");
    sign.className = "hunk-sign";
    sign.setAttribute("aria-hidden", "true");
    sign.textContent = hunk.kind === "removed" ? "-" : hunk.kind === "added" ? "+" : "-+";
    const accept = gutterButton("Accept", `Accept hunk ${index + 1} (a)`, () => handlers.onDecide?.(hunk.id, "accepted"));
    const reject = gutterButton("Reject", `Reject hunk ${index + 1} (r)`, () => handlers.onDecide?.(hunk.id, "rejected"));
    accept.setAttribute("aria-pressed", String(decision === "accepted"));
    reject.setAttribute("aria-pressed", String(decision === "rejected"));
    gutter.append(sign, accept, reject);

    const body = document.createElement("div");
    body.className = "hunk-body";
    const head = document.createElement("div");
    head.className = "hunk-head";
    const kindLabel = document.createElement("span");
    kindLabel.textContent = hunk.kind === "changed" ? "Changed block" : hunk.kind === "added" ? "Added block" : "Removed block";
    const badge = document.createElement("span");
    badge.className = "decision-badge";
    badge.textContent = decision;
    head.append(kindLabel, badge);

    const content = document.createElement("div");
    content.className = "diff-content";
    const oversized = !Array.isArray(hunk.parts);
    content.append(renderHunkParts(hunk.parts, {
      baseText: hunk.baseText,
      proposedText: hunk.proposedText,
      note: oversized
        ? "Diff unavailable for this hunk; showing the full block change."
        : undefined,
    }));

    body.append(head, content);
    card.append(gutter, body);
    container.append(card);
  });
}
