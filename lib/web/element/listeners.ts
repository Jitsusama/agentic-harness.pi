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

/** List what is listening, with the flags that matter. */
export function renderListeners(listeners: readonly Listener[]): string {
	if (listeners.length === 0) {
		return "Nothing is listening on this element.";
	}
	return listeners
		.map((listener) => {
			const parts = [listener.type];
			if (listener.passive) parts.push("passive");
			if (listener.capture) parts.push("capture");
			if (listener.once) parts.push("once");
			// Script line numbers are counted from zero on the wire
			// and from one by every editor a person will open.
			if (listener.source) parts.push(`line ${listener.source.line + 1}`);
			return parts.join("  ");
		})
		.join("\n");
}
