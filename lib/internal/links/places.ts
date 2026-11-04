/**
 * The places a line of text names: URLs, paths, GitHub references and
 * quest ids, each with where it stands in the text.
 *
 * Pure pattern matching over plain text, with no look at the disk: a
 * path found here may not exist, and `targets.ts` says whether it
 * does. A sentence's own punctuation is left out of what is found, so
 * a URL that ends a sentence does not carry its full stop.
 */

import { findIdSpans } from "../quest/id.ts";

/** What kind of place a stretch of text names. */
export type PlaceKind =
	| "url"
	| "github-ref"
	| "quest-id"
	| "path"
	| "issue-number";

/** A place named in a text, and where it stands there. */
export interface Place {
	kind: PlaceKind;
	text: string;
	start: number;
	end: number;
}

/**
 * Characters no place runs through: quotes, angle brackets, the
 * backtick and the box-drawing and block characters pi draws borders
 * with.
 */
const STOP = "\\s\"'`<>\\u2500-\\u259f";

const URL = new RegExp(`\\bhttps?://[^${STOP}]+`, "gi");
const GITHUB_REF = /(?<![\w./-])[A-Za-z0-9][\w.-]*\/[\w.-]+#\d+\b/g;
const ISSUE_NUMBER = /(?<![\w/#&])#\d+\b/g;
const PATH = new RegExp(`(?<![\\w.:/~-])~?/[^${STOP}]+`, "g");

/** What a sentence ends a place with that the place doesn't hold. */
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "*", "_"]);
const CLOSER_OF: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Which kind wins between two places of one width: the more specific. */
const PRECEDENCE: readonly PlaceKind[] = [
	"url",
	"github-ref",
	"quest-id",
	"path",
	"issue-number",
];

/**
 * Every place in `text` that the character at `index` falls in, the
 * widest first, so a path that names a quest id is the path and a URL
 * that holds a `#N` is the URL.
 */
export function placesAt(text: string, index: number): Place[] {
	return findPlaces(text)
		.filter((place) => place.start <= index && index < place.end)
		.sort(
			(a, b) =>
				b.end - b.start - (a.end - a.start) ||
				PRECEDENCE.indexOf(a.kind) - PRECEDENCE.indexOf(b.kind),
		);
}

function findPlaces(text: string): Place[] {
	const places: Place[] = [];
	for (const [kind, pattern] of [
		["url", URL],
		["github-ref", GITHUB_REF],
		["issue-number", ISSUE_NUMBER],
		["path", PATH],
	] as const) {
		for (const match of text.matchAll(pattern)) {
			const found = withoutTrailing(match[0]);
			if (found.length < 2) continue;
			places.push({
				kind,
				text: found,
				start: match.index,
				end: match.index + found.length,
			});
		}
	}
	for (const span of findIdSpans(text)) {
		const { id, start, end } = span;
		places.push({ kind: "quest-id", text: id, start, end });
	}
	return places;
}

/**
 * A match without the punctuation a sentence put after it: a full stop
 * or comma, and a closing bracket the match never opened.
 */
function withoutTrailing(match: string): string {
	let end = match.length;
	for (;;) {
		const last = match[end - 1];
		if (last === undefined) break;
		const opener = CLOSER_OF[last];
		if (TRAILING.has(last) || (opener && !opens(match, end, opener, last))) {
			end--;
			continue;
		}
		break;
	}
	return match.slice(0, end);
}

/** Whether `match` up to `end` opens more `opener`s than it closes before its last. */
function opens(
	match: string,
	end: number,
	opener: string,
	closer: string,
): boolean {
	let depth = 0;
	for (let i = 0; i < end - 1; i++) {
		if (match[i] === opener) depth++;
		else if (match[i] === closer) depth--;
	}
	return depth > 0;
}
