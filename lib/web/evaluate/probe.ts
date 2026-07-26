/**
 * Turning a page value into something that can be carried back.
 *
 * Serialization happens in the page, not in the protocol, and
 * that is a deliberate choice rather than a convenience. Asking
 * the protocol to return a circular object by value does not
 * fail politely: it rejects the whole call with "object
 * reference chain is too long", which takes the evaluation and
 * any honest report of it down together. A DOM node and a
 * function fare no better, coming back as an empty object that
 * says nothing about what they were.
 *
 * This is a presentational judgment and is labelled as one. What
 * a value *is* comes from the browser; how it reads once it has
 * crossed the wire is ours to decide.
 *
 * It ships as a source string because it declares helpers of its
 * own, and the bundler rewrites every named inner binding
 * through a wrapper the page has never heard of.
 */

/** How deep into a structure to go before saying "more". */
export const SERIALIZE_DEPTH = 4;

/** How many entries of a collection to show. */
export const SERIALIZE_BREADTH = 30;

/** How long a single string may be before it is clipped. */
export const SERIALIZE_STRING = 2048;

/**
 * Build the expression that evaluates a caller's code and
 * describes whatever comes back.
 *
 * The caller's expression is wrapped in parentheses so that an
 * object literal reads as a value rather than a block, which is
 * the one piece of syntax people trip over constantly.
 */
export function evaluationSource(expression: string): string {
	return `(() => {
	const DEPTH = ${SERIALIZE_DEPTH};
	const BREADTH = ${SERIALIZE_BREADTH};
	const STRING = ${SERIALIZE_STRING};
	const seen = new WeakSet();
	let clipped = false;

	const describeNode = (node) => {
		if (node.nodeType === 3) return "#text " + JSON.stringify(
			(node.nodeValue || "").slice(0, 40));
		if (node.nodeType === 9) return "#document";
		const id = node.id ? "#" + node.id : "";
		const cls = node.classList && node.classList.length
			? "." + [...node.classList].join(".") : "";
		return "<" + node.tagName.toLowerCase() + id + cls + ">";
	};

	const walk = (value, depth) => {
		if (value === null) return null;
		const kind = typeof value;
		if (kind === "undefined") return "[undefined]";
		if (kind === "boolean" || kind === "number") return value;
		if (kind === "bigint") return String(value) + "n";
		if (kind === "symbol") return String(value);
		if (kind === "string") {
			if (value.length <= STRING) return value;
			clipped = true;
			return value.slice(0, STRING) + "... (" + value.length + " chars)";
		}
		if (kind === "function") {
			return "[function " + (value.name || "anonymous") + "]";
		}

		if (value instanceof Error) {
			return "[" + value.name + ": " + value.message + "]";
		}
		if (typeof Node !== "undefined" && value instanceof Node) {
			return describeNode(value);
		}
		if (typeof Window !== "undefined" && value instanceof Window) {
			return "[window]";
		}

		// Circularity is checked before descending, so a structure
		// that points at itself is named rather than followed.
		if (seen.has(value)) return "[circular]";
		seen.add(value);

		if (depth >= DEPTH) {
			clipped = true;
			return Array.isArray(value) ? "[array, deeper]" : "[object, deeper]";
		}

		if (Array.isArray(value)) {
			const shown = value.slice(0, BREADTH).map((item) => walk(item, depth + 1));
			if (value.length > BREADTH) {
				clipped = true;
				shown.push("... " + (value.length - BREADTH) + " more");
			}
			return shown;
		}
		if (value instanceof Map || value instanceof Set) {
			const items = [...value].slice(0, BREADTH)
				.map((item) => walk(item, depth + 1));
			if (value.size > BREADTH) {
				clipped = true;
				items.push("... " + (value.size - BREADTH) + " more");
			}
			return { ["[" + value.constructor.name + "]"]: items };
		}
		if (typeof NodeList !== "undefined" && value instanceof NodeList) {
			return [...value].slice(0, BREADTH).map(describeNode);
		}

		const out = {};
		const keys = Object.keys(value);
		for (const key of keys.slice(0, BREADTH)) {
			try {
				out[key] = walk(value[key], depth + 1);
			} catch (error) {
				// A getter that throws is the page's problem, not a
				// reason to lose everything else on the object.
				out[key] = "[threw: " + error.message + "]";
			}
		}
		if (keys.length > BREADTH) {
			clipped = true;
			out["..."] = (keys.length - BREADTH) + " more keys";
		}
		return out;
	};

	const typeOf = (value) => {
		if (value === null) return "null";
		if (Array.isArray(value)) return "array";
		if (typeof Node !== "undefined" && value instanceof Node) return "node";
		return typeof value;
	};

	const value = (${expression});
	return Promise.resolve(value).then((settled) => ({
		type: typeOf(settled),
		value: walk(settled, 0),
		clipped,
	}));
})()`;
}
