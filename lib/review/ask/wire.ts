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

/** An answer, and whether it is all of one. */
export interface AnswerRead {
	/** The object the answer carried, whole or salvaged. */
	readonly parsed: Record<string, unknown> | undefined;
	/** Whether what came back is the surviving part of a longer answer. */
	readonly truncated: boolean;
}

/**
 * What a reviewer said, taking the part that survived over nothing.
 *
 * Every round reads its answer the same way and can be interrupted in
 * the same place, so the fallback belongs here rather than four times
 * over. A caller that must know it is holding half an answer reads
 * `truncated`, and every caller must, because a partial answer that
 * does not say so is a reviewer that appears to have found less than
 * it did.
 */
export function readAnswer(text: string, key: string): AnswerRead {
	const whole = findJson(text);
	if (whole !== undefined) return { parsed: whole, truncated: false };
	const salvaged = salvageEntries(text, key);
	return salvaged.length === 0
		? { parsed: undefined, truncated: false }
		: { parsed: { [key]: salvaged }, truncated: true };
}

/**
 * How a round says an answer stopped early.
 *
 * Worth wording once. The reader has to come away knowing that the
 * gap is unmeasured, or a truncated answer gets read as a thorough
 * one, which is how a round can look complete while missing the
 * finding that mattered.
 */
export const ANSWER_WAS_CUT_OFF =
	"This answer was cut off partway through, so what follows is what survived: everything the reviewer completed before it stopped, and not the entry it was in the middle of. There is no way to tell how much more it would have sent, so treat an absence here as unknown rather than as nothing to report.";

/**
 * What an answer still holds after it was cut off.
 *
 * A reviewer stopped at its budget stops wherever it had got to,
 * which for a long answer is partway through the findings array. The
 * text will not parse, and dropping it loses every finding that did
 * arrive whole along with the one that did not.
 *
 * Nothing is repaired. Each entry of the named array is taken on its
 * own and handed to the parser by itself: one that finished parses,
 * one that did not, does not. An earlier version cut the text at a
 * point where everything open could be closed and let the closers do
 * the rest, which is a property of the syntax rather than of the
 * entries. Every real finding holds a nested location, so an entry
 * interrupted after that location closed satisfied the rule, and a
 * half-written finding came back looking exactly like a whole one
 * with its argument missing. A finding completed by guesswork cannot
 * be told from one the reviewer made, which is the one outcome worth
 * refusing outright.
 *
 * Anchored on the key rather than the first brace, which is also why
 * a brace in the reviewer's prose no longer costs the answer: `findJson`
 * learned that lesson already and its docstring says so. Where an
 * answer holds several anchors, because a reviewer sketched a smaller
 * array before writing the real one, the richest wins on the same
 * reasoning as the widest span.
 */
export function salvageEntries(text: string, key: string): unknown[] {
	let best: unknown[] = [];
	const anchor = new RegExp(`"${key}"\\s*:\\s*\\[`, "g");
	for (const found of text.matchAll(anchor)) {
		const at = (found.index ?? 0) + found[0].length;
		const entries = entriesFrom(text, at);
		if (entries.length > best.length) best = entries;
	}
	return best;
}

/**
 * The whole entries of an array, reading from just inside its bracket.
 *
 * Depth is counted relative to the array, so a boundary means the end
 * of one of its entries and never the end of something nested inside
 * one. An entry still open when the text runs out is not an entry.
 */
function entriesFrom(text: string, from: number): unknown[] {
	const entries: unknown[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	const take = (end: number): void => {
		if (start === -1) return;
		try {
			entries.push(JSON.parse(text.slice(start, end)));
		} catch {
			// Whatever this was, the reviewer did not finish saying it.
		}
		start = -1;
	};

	for (let at = from; at < text.length; at++) {
		const char = text[at];

		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}

		if (char === '"') {
			if (start === -1) start = at;
			inString = true;
		} else if (char === "{" || char === "[") {
			if (start === -1) start = at;
			depth++;
		} else if (char === "}" || char === "]") {
			// At depth zero this closes the array itself, or the object
			// holding it, so the last entry ends here and so does the walk.
			if (depth === 0) {
				take(at);
				break;
			}
			depth--;
		} else if (char === "," && depth === 0) {
			take(at);
		} else if (start === -1 && !/\s/.test(char)) {
			start = at;
		}
	}
	return entries;
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
