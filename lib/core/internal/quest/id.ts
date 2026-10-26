/**
 * Quest and document ID minting.
 *
 * IDs are deterministic in shape, random in suffix:
 *
 *     PREFIX-YYYYMMDD-XXXXXX
 *
 * `PREFIX` is one of the four-character codes for our
 * document kinds. `YYYYMMDD` is the creation date in the
 * local timezone (we never coordinate IDs across timezones,
 * so local is what the user expects to see). `XXXXXX` is a
 * six-character base-36 (upper) random suffix giving roughly
 * 2.18 billion distinct IDs per kind per day.
 */

import { randomBytes } from "node:crypto";

/** Recognised ID prefixes for the four document kinds plus quests. */
export const ID_PREFIXES = ["QEST", "PLAN", "RSCH", "BRIF", "RPRT"] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

// YYYY: 1900-2999. MM: 01-12. DD: 01-31. This is a
// shape check, not a perfect calendar validator: it
// rejects the obvious garbage (00000000, 20261345) the
// old `\d{8}` accepted while staying cheap.
const DATE_PATTERN =
	"(?:19|2[0-9])\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])";
const ID_REGEX = new RegExp(
	`^(${ID_PREFIXES.join("|")})-(${DATE_PATTERN})-([0-9A-Z]{6})$`,
);
const ID_REGEX_BODY = `(${ID_PREFIXES.join("|")})-(${DATE_PATTERN})-([0-9A-Z]{6})`;

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
 * Mint a fresh ID. The date defaults to `new Date()`; tests
 * pass a fixed date for stable output.
 */
export function mintId(prefix: IdPrefix, date: Date = new Date()): string {
	return `${prefix}-${ymd(date)}-${randomSuffix()}`;
}

/** Quick validation: is this string a valid ID? */
export function isId(text: string): boolean {
	return ID_REGEX.test(text);
}

/** Extract the prefix from an ID, or `undefined` for an invalid ID. */
export function prefixOf(id: string): IdPrefix | undefined {
	const match = ID_REGEX.exec(id);
	return match ? (match[1] as IdPrefix) : undefined;
}

/** Extract the date portion (YYYYMMDD) from an ID, or `undefined`. */
export function dateOf(id: string): string | undefined {
	const match = ID_REGEX.exec(id);
	return match ? match[2] : undefined;
}

/** Find every valid ID in a body of text. */
export function findIds(text: string): string[] {
	// We need a no-anchor flavour of the regex so it can
	// scan the middle of a string. The `\b` boundary keeps
	// us from matching IDs embedded inside longer tokens.
	const scan = new RegExp(`\\b${ID_REGEX_BODY}\\b`, "g");
	const out: string[] = [];
	const seen = new Set<string>();
	for (const m of text.matchAll(scan)) {
		if (!seen.has(m[0])) {
			seen.add(m[0]);
			out.push(m[0]);
		}
	}
	return out;
}

/**
 * How an inline ID mention reads. A bare `QEST-...` reads
 * as a `reference`. An id preceded by the `→` sigil
 * (after optional whitespace) reads as `produced`: the
 * containing document is the work that produced the
 * mentioned id.
 */
export type IdMentionRelation = "produced" | "reference";

export interface IdMention {
	id: string;
	relation: IdMentionRelation;
}

/**
 * Find every ID in a body of text and classify each
 * mention as a bare reference or a produced-by sigil hit.
 * When the same id appears more than once, the strongest
 * relation wins: a single `→ ID` anywhere upgrades the
 * record from `reference` to `produced`.
 */
export function findIdsWithRelation(text: string): IdMention[] {
	const scan = new RegExp(`\\b${ID_REGEX_BODY}\\b`, "g");
	const seen = new Map<string, IdMentionRelation>();
	const order: string[] = [];
	for (const m of text.matchAll(scan)) {
		const id = m[0];
		const start = m.index ?? 0;
		const relation = sigilBefore(text, start) ? "produced" : "reference";
		const prev = seen.get(id);
		if (prev === undefined) {
			order.push(id);
			seen.set(id, relation);
			continue;
		}
		if (prev === "reference" && relation === "produced") {
			seen.set(id, relation);
		}
	}
	return order.map((id) => ({
		id,
		relation: seen.get(id) ?? "reference",
	}));
}

function sigilBefore(text: string, idStart: number): boolean {
	// Walk backwards past whitespace; if we hit a → with
	// nothing but whitespace in between, the id reads as
	// `produced`. Anything else (text, punctuation, line
	// boundary) means bare reference.
	let i = idStart - 1;
	while (i >= 0 && /\s/.test(text[i])) i--;
	return i >= 0 && text[i] === "\u2192";
}
