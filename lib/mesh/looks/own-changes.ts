/**
 * The changes a session put up itself, which never go on the person's
 * look list. Joel, 24 November, of a draft PR a session pointed him at:
 * "don't fucking put prs in my look list, review it your fucking self
 * and take it out of draft and ask for review wheeen you are comfortable
 * with it." A session's own change is reviewed by its own councils and
 * asked of reviewers; pointing him at it hands him the work.
 *
 * Two places say what a session proposed: its log's review_offer
 * answers, and a record kept per quest (or per session, with none) as
 * review_offer says each proposal on the bus. The log is lost to a
 * rollover, a /tree or a fork; the record is not, and it also holds what
 * the quest's other sessions proposed, and what a codemode script
 * proposed through review_offer, whose answer never reaches the log.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../../internal/record.ts";
import { writeWhole } from "../../internal/write-whole.ts";

/** The tool a session proposes its changes with. */
const PROPOSING_TOOL = "review_offer";

/** How many of an owner's proposals its record keeps, newest last. */
export const MOST_KEPT = 200;

/** The version of a record's shape. */
const RECORD_VERSION = 1;

/**
 * The URLs of the changes a session proposed, read from its log's
 * branch: each review_offer answer that names one or several.
 */
export function proposedIn(entries: readonly unknown[]): string[] {
	const urls: string[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message) || message.role !== "toolResult") continue;
		if (message.toolName !== PROPOSING_TOOL) continue;
		const details = message.details;
		if (!isRecord(details)) continue;
		const one = details.url;
		if (typeof one === "string" && one !== "") urls.push(one);
		const several = details.urls;
		if (Array.isArray(several)) {
			for (const url of several) {
				if (typeof url === "string" && url !== "") urls.push(url);
			}
		}
	}
	return urls;
}

/**
 * A change's URL as compared: one case, https, no `www.`, no query,
 * fragment or trailing slash, and a GitHub pull request's `.diff` or
 * `.patch` read as the pull request. GitHub reads owners and names in
 * any case, so a differently spelled URL opens the same change.
 */
export function changeKey(url: string): string {
	return url
		.trim()
		.toLowerCase()
		.replace(/^http:\/\//, "https://")
		.replace(/^https:\/\/www\./, "https://")
		.replace(/[?#].*$/, "")
		.replace(/\/+$/, "")
		.replace(/(\/pull\/\d+)\.(?:diff|patch)$/, "$1");
}

/**
 * Whether `target` opens one of `proposed`, or a tab, diff or comment
 * of one, as `…/pull/12/files`, `…/pull/12.diff` or
 * `…/pull/12#discussion` is of `…/pull/12`, but `…/pull/123` is not.
 */
export function opensOneOf(
	target: string,
	proposed: readonly string[],
): boolean {
	const opened = changeKey(target);
	return proposed.some((url) => {
		const change = changeKey(url);
		if (change === "") return false;
		return opened === change || opened.startsWith(`${change}/`);
	});
}

/** Where the records of what each quest or session proposed are kept, beside the looks. */
export function ownChangesBeside(looks: string): string {
	return join(dirname(looks), "own-changes");
}

/** The file an owner's record is kept in: a quest's id or a session's. */
function recordFile(dir: string, owner: string): string {
	return join(dir, `${owner.replace(/[^\w-]/g, "_")}.json`);
}

/** What an owner's record holds, or nothing where none is kept or it is torn. */
function readKept(file: string): string[] {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		// No record yet: nothing proposed under this owner.
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		// A torn record holds nothing to go by; the next proposal rewrites it.
		return [];
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.urls)) return [];
	return parsed.urls.filter(
		(url): url is string => typeof url === "string" && url !== "",
	);
}

/**
 * Keep `urls` as proposed under `owner`, beside what it already holds,
 * the newest {@link MOST_KEPT}. Nothing when `owner` is empty.
 */
export function keepProposed(
	dir: string,
	owner: string,
	urls: readonly string[],
): void {
	if (owner.trim() === "" || urls.length === 0) return;
	const file = recordFile(dir, owner);
	const kept = readKept(file);
	const known = new Set(kept.map(changeKey));
	for (const url of urls) {
		const key = changeKey(url);
		if (key === "" || known.has(key)) continue;
		known.add(key);
		kept.push(url.trim());
	}
	writeWhole(
		file,
		`${JSON.stringify({ v: RECORD_VERSION, urls: kept.slice(-MOST_KEPT) })}\n`,
	);
}

/** The URLs kept as proposed under any of `owners`. */
export function keptProposed(
	dir: string,
	owners: readonly (string | undefined)[],
): string[] {
	return owners
		.filter((owner): owner is string => !!owner && owner.trim() !== "")
		.flatMap((owner) => readKept(recordFile(dir, owner)));
}

/** What a session is told when it points the person at its own change. */
export const OWN_CHANGE_REFUSED =
	"This session or its quest proposed that change, and the person reviews no change his sessions put up (Joel, 24 November: review it yourself, take it out of draft and ask for review when you are comfortable with it). Have a council read it, fix what holds, mark it ready and ask its reviewers with review_offer; what only he can decide goes to him as a question, through mesh_send to person.";
