/**
 * Reading what a model actually sent.
 *
 * A model answers in prose with JSON somewhere inside it, however
 * firmly it was asked not to, and every round has to cope with the
 * same handful of shapes. This is shared rather than copied because it
 * is one concept and not two that merely look alike: if models change
 * how they wrap an answer, every round is wrong in the same way at the
 * same time, and there should be one place to fix it.
 */

/**
 * The JSON object in an answer, wherever it is.
 *
 * Tries the whole answer, then a fenced block, then the widest
 * brace-delimited span. Widest rather than first, because a model that
 * reasons before answering often writes a smaller object earlier in
 * the prose. The fence is tried before the span because a model
 * quoting code in its reasoning puts braces in the prose, and the span
 * then swallows the prose and parses as nothing.
 */
export function findJson(text: string): Record<string, unknown> | undefined {
	const whole = parseObject(text);
	if (whole !== undefined) return whole;

	for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
		const fenced = parseObject(match[1] ?? "");
		if (fenced !== undefined) return fenced;
	}

	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first === -1 || last <= first) return undefined;
	return parseObject(text.slice(first, last + 1));
}

/** One JSON object, or nothing. */
function parseObject(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	try {
		const held: unknown = JSON.parse(trimmed);
		return isRecord(held) ? held : undefined;
	} catch {
		// Not JSON. Every caller is guessing at where the JSON might
		// be, so failing to find it is the expected outcome rather
		// than an error worth reporting.
		return undefined;
	}
}

/**
 * A non-empty trimmed string, or nothing.
 *
 * Absent and blank are the same answer here. A model that sent a field
 * full of spaces did not fill it in, and holding the spaces would let
 * an empty subject or a whitespace id through to somewhere that treats
 * it as a name.
 */
export function wireText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/** A whole number, or nothing. */
export function wireWhole(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value)
		? value
		: undefined;
}

/** A plain object, as against an array or a primitive. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
