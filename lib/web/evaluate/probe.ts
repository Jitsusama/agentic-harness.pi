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
 * Whether a source text is a single JavaScript expression.
 *
 * Decided here rather than in the page. The page could answer it
 * with new Function, but that is exactly what a strict
 * Content-Security-Policy forbids, and an inspection tool must
 * not fail on the pages most worth inspecting. The grammar is
 * the same in both runtimes, and compiling is not running: this
 * never executes the caller's code, so a reference to a page
 * global that does not exist here is irrelevant.
 */
function isExpression(source: string): boolean {
	try {
		new Function(`return (${source});`);
		return true;
	} catch {
		// A syntax error means it is not one expression. Whether it is
		// valid at all is the page's business to report, not ours.
		return false;
	}
}

/**
 * How the caller's code is turned into one value.
 *
 * An expression is parenthesized so an object literal reads as a
 * value rather than a block, which is the syntax people trip
 * over constantly. Anything else is run as a statement list, the
 * way a console accepts one, because `scrollTo(0, 400); check()`
 * is a thing people type and it used to come back as
 * "SyntaxError: Unexpected token ';'", which reads as the
 * caller's mistake rather than ours. A statement list answers
 * with whatever it returns.
 */
function producer(expression: string): string {
	return isExpression(expression)
		? `(${expression})`
		: `(() => { ${expression} })()`;
}

/**
 * Build the expression that evaluates a caller's code and
 * describes whatever comes back.
 */
export function evaluationSource(expression: string): string {
	return `(() => {
	const DEPTH = ${SERIALIZE_DEPTH};
	const BREADTH = ${SERIALIZE_BREADTH};
	const STRING = ${SERIALIZE_STRING};
	// The chain of ancestors currently being walked, not every
	// object ever seen: a value reachable by two paths is shared,
	// and only a value that contains itself is circular.
	const path = new Set();
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
		if (kind === "boolean") return value;
		// JSON has no NaN and no Infinity, so passing them straight
		// through turned three of the answers a console most often
		// gives into "number: null", which is a wrong answer wearing a
		// right one's clothes. bigint below is tagged for this reason.
		if (kind === "number") {
			return Number.isFinite(value) ? value : String(value);
		}
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
		//
		// Only an ancestor counts. This used to be every object ever
		// visited, never unwound, so an object holding the same store
		// under two keys reported the second as circular when nothing
		// pointed at itself. The unwind is in the finally below so no
		// branch can forget it.
		if (path.has(value)) return "[circular]";
		path.add(value);
		try {
			return descend(value, depth);
		} finally {
			path.delete(value);
		}
	};

	const descend = (value, depth) => {
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

	const value = ${producer(expression)};
	return Promise.resolve(value).then((settled) => ({
		type: typeOf(settled),
		value: walk(settled, 0),
		clipped,
	}));
})()`;
}
