/**
 * Extract the first balanced JSON array from a string.
 *
 * A model reply often wraps its JSON array in prose that itself
 * contains brackets (`... see line [42]`). A greedy `/\[.*\]/`
 * spans to the last bracket and fails to parse, silently dropping
 * the whole payload. This scans from the first `[` to its
 * matching `]`, respecting string literals and escapes, so the
 * intended array is recovered regardless of trailing brackets.
 */
export function firstJsonArray(text: string): string | undefined {
	const start = text.indexOf("[");
	if (start < 0) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "[") depth++;
		else if (ch === "]") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return undefined;
}
