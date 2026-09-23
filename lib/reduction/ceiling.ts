import { createHash } from "node:crypto";

/**
 * A ceiling on tool output, for the fat-tail tools that have one: read,
 * slack, vault and a handful of others with rare, enormous results
 * pulling the mean far above the typical case. bash is deliberately not
 * one of these: its results are uniformly small, so a ceiling would
 * never fire and the "fat tail" this exists to cut is not there.
 *
 * This is a quality trade, not provable waste: the truncated remainder
 * might have been the part that mattered. That is why it keeps a digest
 * of the full original rather than discarding it outright, and why
 * wiring this live is a separate, deliberate step from writing it.
 */

const DIGEST_CHARS = 16;

export interface CeilingResult {
	readonly truncated: boolean;
	readonly text: string;
	readonly originalChars: number;
	/** Only set when truncated, since an untouched result has nothing to point back at. */
	readonly digest?: string;
}

/** Digest the full text this ceiling is about to cut, for later lookup. */
function digestOf(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, DIGEST_CHARS);
}

/** Cut `text` to `maxChars` if it exceeds it, keeping a digest of the whole. */
export function applyCeiling(text: string, maxChars: number): CeilingResult {
	if (text.length <= maxChars) {
		return { truncated: false, text, originalChars: text.length };
	}
	return {
		truncated: true,
		text: text.slice(0, maxChars),
		originalChars: text.length,
		digest: digestOf(text),
	};
}
