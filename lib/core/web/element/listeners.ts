/**
 * What is listening on an element.
 *
 * A control that looks dead and a control that is merely quiet
 * are indistinguishable from the outside. The handlers attached
 * to it say which, and the flags on them explain behaviour that
 * otherwise looks like a bug: a passive listener cannot cancel
 * the default, a capture listener runs before anything below,
 * a once listener has already gone after the first click.
 */

/** A listener as the capture reported it. */
export interface RawListener {
	readonly type: string;
	readonly useCapture?: boolean;
	readonly passive?: boolean;
	readonly once?: boolean;
	readonly scriptId?: string;
	readonly lineNumber?: number;
	readonly columnNumber?: number;
}

/** A handler attached to an element. */
export interface Listener {
	readonly type: string;
	readonly capture: boolean;
	readonly passive: boolean;
	readonly once: boolean;
	readonly source?: {
		readonly script: string;
		readonly line: number;
		readonly column?: number;
	};
}

/** Read a capture's listeners. */
export function normalizeListeners(
	raw: readonly RawListener[],
): readonly Listener[] {
	return raw.map((listener) => {
		const source =
			listener.scriptId !== undefined && listener.lineNumber !== undefined
				? {
						script: listener.scriptId,
						line: listener.lineNumber,
						...(listener.columnNumber === undefined
							? {}
							: { column: listener.columnNumber }),
					}
				: undefined;
		return {
			type: listener.type,
			capture: listener.useCapture === true,
			passive: listener.passive === true,
			once: listener.once === true,
			...(source === undefined ? {} : { source }),
		};
	});
}

/**
 * The ancestors an event from here would travel through.
 *
 * Runs with the element as its receiver, and walks to the top.
 * Ordered from the nearest outwards, which is the order the
 * event visits them in while it bubbles.
 *
 * Not capped at a depth. The document is the last hop and the
 * commonest place of all to bind a delegated handler, so a cap
 * would drop the very ancestor most worth reporting. A parent
 * chain cannot cycle, and its length is the depth of the
 * document.
 *
 * Page source rather than a function, for the reason given in
 * the accessibility observer.
 */
export const ANCESTORS_PROBE = `function () {
  var chain = [];
  var node = this.parentNode || this.host;
  while (node) {
    chain.push(node);
    node = node.parentNode || node.host;
  }
  return chain;
}`;

/** Handlers on an ancestor, which events from here reach. */
export interface DelegatedListeners {
	/** The ancestor, as a reader would recognize it: `div#app`. */
	readonly element: string;
	readonly listeners: readonly Listener[];
}

/** One handler, with the flags that change what it does. */
function describe(listener: Listener): string {
	const parts = [listener.type];
	if (listener.passive) parts.push("passive");
	if (listener.capture) parts.push("capture");
	if (listener.once) parts.push("once");
	// Script line numbers are counted from zero on the wire
	// and from one by every editor a person will open.
	if (listener.source) parts.push(`line ${listener.source.line + 1}`);
	return parts.join("  ");
}

/**
 * List what is listening, with the flags that matter.
 *
 * Handlers on ancestors are named too, because an event that
 * leaves this element still reaches them. A button whose click
 * was handled by a delegate on the body reported that nothing
 * was listening, which is true of the button and the opposite of
 * the answer the reader came for: the click worked. Delegation
 * is how most frameworks bind, so the element's own handlers are
 * frequently the empty half of the story.
 *
 * Whose handler it is stays visible, since that decides which
 * runs first and which file to go and edit.
 */
export function renderListeners(
	listeners: readonly Listener[],
	delegated: readonly DelegatedListeners[] = [],
): string {
	const catching = delegated.filter((on) => on.listeners.length > 0);
	if (listeners.length === 0 && catching.length === 0) {
		return "Nothing is listening on this element.";
	}
	const lines =
		listeners.length === 0
			? ["Nothing is listening on this element itself."]
			: listeners.map(describe);
	for (const on of catching) {
		lines.push(
			`  on ${on.element}, which events from here reach:`,
			...on.listeners.map((listener) => `    ${describe(listener)}`),
		);
	}
	return lines.join("\n");
}
