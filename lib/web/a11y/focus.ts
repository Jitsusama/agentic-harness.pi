/**
 * What holds focus at this moment.
 *
 * Distinct from the keyboard walk, which presses Tab around the whole
 * page and judges the journey. This answers the question asked
 * between actions: after that click, that key, that navigation, where
 * did focus end up? It moves nothing.
 */

/**
 * Ask the page what holds focus, without moving it.
 *
 * Shipped as a source string because it declares helpers. The
 * accessible name is read the cheap way, from the attributes and
 * text that produce one, rather than from the accessibility tree:
 * this has to answer between actions without a tree walk, and the
 * name is only there to identify what is already known to be
 * focused.
 */
export const FOCUS_PROBE = `(() => {
  const active = () => {
    // Focus inside a shadow root reads as the host from outside, so
    // the chain is followed down to the element that really has it.
    let el = document.activeElement;
    let shadowed = false;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
      shadowed = true;
    }
    return { el: el, shadowed: shadowed };
  };

  const found = active();
  const el = found.el;
  if (!el) return undefined;

  const tag = el.tagName ? el.tagName.toLowerCase() : "unknown";
  const onBody = el === document.body || tag === "html";
  const labelled = () => {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const by = el.getAttribute && el.getAttribute("aria-labelledby");
    if (by) {
      const names = by.split(/\\s+/).map((id) => {
        const target = document.getElementById(id);
        return target ? (target.textContent || "").trim() : "";
      });
      const joined = names.filter(Boolean).join(" ");
      if (joined) return joined;
    }
    if (el.labels && el.labels.length > 0) {
      return (el.labels[0].textContent || "").trim();
    }
    const own = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (own) return own.slice(0, 80);
    const value = el.getAttribute && el.getAttribute("value");
    return value ? value.trim() : "";
  };

  const box = el.getBoundingClientRect ? el.getBoundingClientRect() : undefined;
  const name = onBody ? "" : labelled();
  const role = el.getAttribute && el.getAttribute("role");
  return {
    tag: tag,
    role: role || undefined,
    name: name || undefined,
    id: (el.id || undefined),
    onBody: onBody,
    inShadow: found.shadowed || undefined,
    rect: box && (box.width > 0 || box.height > 0)
      ? { x: box.x, y: box.y, width: box.width, height: box.height }
      : undefined,
  };
})()`;

/** The element focus is on, as the page reports it. */
export interface FocusHolder {
	readonly tag: string;
	readonly role?: string;
	readonly name?: string;
	readonly id?: string;
	/** Focus is parked on the body, which means nothing holds it. */
	readonly onBody: boolean;
	readonly inShadow?: boolean;
	readonly rect?: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
}

/** Say what holds focus, in the vocabulary the outline uses. */
export function renderFocus(holder: FocusHolder | undefined): string {
	if (!holder) {
		return (
			"WARN what holds focus could not be read\n\n" +
			"The page did not answer, which happens when nothing is " +
			"loaded yet. Navigate, then ask again."
		);
	}

	if (holder.onBody) {
		// Naming the body as the holder would read as a real control and
		// hide the useful finding, which is that a key press went
		// nowhere.
		return (
			"Nothing holds focus.\n\n" +
			"Focus is parked on the document, which is where the browser " +
			"leaves it when no control has been given it. A tab from here " +
			"starts at the top of the page."
		);
	}

	// The role and name pair is how every other surface here addresses
	// an element, so the answer can be pasted straight into a target.
	const called = holder.role ?? holder.tag;
	const named = holder.name ? ` "${holder.name}"` : "";
	const notes = [
		holder.role && holder.role !== holder.tag ? `<${holder.tag}>` : "",
		holder.id ? `#${holder.id}` : "",
		holder.inShadow ? "inside a shadow root" : "",
		holder.rect ? `at ${place(holder.rect)}` : "",
	].filter(Boolean);
	const tail = notes.length > 0 ? `\n\n${notes.join(", ")}` : "";
	return `${called}${named} holds focus.${tail}`;
}

function place(rect: NonNullable<FocusHolder["rect"]>): string {
	return (
		`${Math.round(rect.x)},${Math.round(rect.y)} ` +
		`${Math.round(rect.width)}x${Math.round(rect.height)}`
	);
}
