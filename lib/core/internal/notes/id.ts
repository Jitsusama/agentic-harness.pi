/**
 * Note ID minting and validation.
 *
 * IDs are deterministic in shape, random in suffix, the same
 * pattern quest uses for its own ids (see
 * `internal/quest/id.ts`):
 *
 *     NOTE-YYYYMMDD-XXXXXX
 *
 * `YYYYMMDD` is the note's creation date (local timezone, or
 * whatever the original source recorded) so ids sort
 * chronologically by construction. `XXXXXX` is a
 * six-character base-36 (upper) random suffix, giving
 * roughly 2.18 billion distinct ids per day -- collisions in
 * practice require an explicit check, not a probability
 * argument.
 *
 * Unlike quest, there is exactly one prefix here: a note
 * owns no child documents of a different kind, so there is
 * nothing for a second prefix to distinguish.
 */

import { randomBytes } from "node:crypto";

const PREFIX = "NOTE";

// YYYY: 1900-2999. MM: 01-12. DD: 01-31. Shape check, not a
// calendar validator -- rejects the obvious garbage
// (00000000, 20261345) a bare `\d{8}` would accept, without
// the cost of real calendar math nothing here needs.
const DATE_PATTERN =
	"(?:19|2[0-9])\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])";
const ID_REGEX = new RegExp(`^${PREFIX}-(${DATE_PATTERN})-([0-9A-Z]{6})$`);

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

function ymd(date: Date): string {
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** Build a six-character base-36 uppercase random suffix. */
function randomSuffix(): string {
	const bytes = randomBytes(6);
	const out: string[] = [];
	for (let i = 0; i < 6; i++) {
		out.push((bytes[i] % 36).toString(36).toUpperCase());
	}
	return out.join("");
}

/**
 * Mint a fresh id. `date` defaults to now; tests and
 * backdated imports pass a fixed date so the `YYYYMMDD`
 * portion reflects the note's real creation date rather than
 * the moment it was minted.
 */
export function mintId(date: Date = new Date()): string {
	return `${PREFIX}-${ymd(date)}-${randomSuffix()}`;
}

/**
 * Mint a fresh id from an already-formatted `YYYYMMDD` (or
 * longer, e.g. `YYYYMMDDTHHMMSSZ`) string, the shape a note's
 * own `created` front-matter field is in. Falls back to
 * today's date when the string doesn't start with eight
 * digits, rather than throwing -- a malformed or missing
 * `created` field on import is a data-quality problem to
 * flag separately, not a reason to refuse minting an id.
 */
export function mintIdFromDateString(dateString: string | undefined): string {
	const match = dateString?.match(/^(\d{8})/);
	const datePart = match?.[1];
	if (!datePart) return mintId();
	const year = Number(datePart.slice(0, 4));
	const month = Number(datePart.slice(4, 6));
	const day = Number(datePart.slice(6, 8));
	return mintId(new Date(year, month - 1, day));
}

/** Quick validation: is this string a valid note id? */
export function isId(text: string): boolean {
	return ID_REGEX.test(text);
}

/** Extract the `YYYYMMDD` date portion from an id, or `undefined`. */
export function dateOf(id: string): string | undefined {
	return ID_REGEX.exec(id)?.[1];
}
