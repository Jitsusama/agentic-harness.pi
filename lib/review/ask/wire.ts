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
export function readAnswer(text: string): AnswerRead {
	const whole = findJson(text);
	if (whole !== undefined) return { parsed: whole, truncated: false };
	const salvaged = salvageJson(text);
	return { parsed: salvaged, truncated: salvaged !== undefined };
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
 * So: walk the answer, remember the last point at which everything
 * open could be closed honestly, cut there and close it. What comes
 * back is the entries that finished. The interrupted one is left
 * behind rather than repaired, because a finding completed by
 * guesswork is indistinguishable from one the reviewer actually made.
 *
 * This is deliberately not folded into `findJson`. A caller reaching
 * for salvage is accepting a partial answer, and that is a decision
 * to make on purpose rather than to inherit from a parser that
 * quietly did its best.
 */
export function salvageJson(text: string): Record<string, unknown> | undefined {
	const start = text.indexOf("{");
	if (start === -1) return undefined;

	const open: string[] = [];
	let cut: { at: number; open: string[] } | undefined;
	let inString = false;
	let escaped = false;

	for (let at = start; at < text.length; at++) {
		const char = text[at];

		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}

		if (char === '"') inString = true;
		else if (char === "{" || char === "[") open.push(char);
		else if (char === "}" || char === "]") {
			open.pop();
			// A value just finished. If it sits inside something, the
			// answer can be truthfully ended here by closing what is
			// still open, so this is the furthest safe cut so far.
			if (open.length > 0) cut = { at: at + 1, open: [...open] };
		}
	}

	if (cut === undefined) return undefined;
	const closers = cut.open
		.reverse()
		.map((char) => (char === "{" ? "}" : "]"))
		.join("");
	return parseObject(text.slice(start, cut.at) + closers);
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
