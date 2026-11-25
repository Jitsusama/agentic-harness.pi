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
 *
 * A record is a folder per owner holding a file per change, each
 * written whole and never rewritten, so two sessions of one quest
 * proposing at once both keep theirs, and a torn file loses only itself.
 */

import { createHash } from "node:crypto";
import {
	constants,
	copyFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../../internal/record.ts";
import type { Authored } from "../../internal/session/authored.ts";
import { writeWhole } from "../../internal/write-whole.ts";

/** The tool a session proposes its changes with. */
const PROPOSING_TOOL = "review_offer";

/** The version of a kept change's shape. */
const RECORD_VERSION = 1;

/**
 * The fewest path segments a change's URL names past its host, as
 * `/c/123` does at least and `/owner/name/pull/12` more: a bare host,
 * or one segment, would refuse every look under it for good.
 */
const CHANGE_SEGMENTS = 2;

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
 * any case, so a differently spelled URL opens the same change; it
 * sends `/issues/N` of a pull request to the pull request, and
 * Graphite's view of one is the same change (the GitHub provider's
 * claims read it so).
 */
export function proposedKey(url: string): string {
	return url
		.trim()
		.toLowerCase()
		.replace(/^http:\/\//, "https://")
		.replace(/^https:\/\/www\./, "https://")
		.replace(
			/^https:\/\/app\.graphite\.(?:com|dev)\/github\/pr\/([^/]+)\/([^/]+)\/(\d+)/,
			"https://github.com/$1/$2/pull/$3",
		)
		.replace(
			/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/issues\/(\d+)/,
			"$1/pull/$2",
		)
		.replace(/[?#].*$/, "")
		.replace(/\/+$/, "")
		.replace(/(\/pull\/\d+)\.(?:diff|patch)$/, "$1");
}

/**
 * Whether a compared key names one change rather than a host or a
 * folder of them: an https URL with a host and at least two path
 * segments past it. Anything less is never kept or compared, since a
 * kept prefix that wide would refuse every look beneath it.
 */
export function namesChange(key: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(key);
	} catch {
		// Not a URL at all, so it names no change.
		return false;
	}
	if (parsed.protocol !== "https:" || parsed.hostname === "") return false;
	const segments = parsed.pathname.split("/").filter((part) => part !== "");
	return segments.length >= CHANGE_SEGMENTS;
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
	const opened = proposedKey(target);
	return proposed.some((url) => {
		const change = proposedKey(url);
		if (!namesChange(change)) return false;
		return opened === change || opened.startsWith(`${change}/`);
	});
}

/** Where the records of what each quest or session proposed are kept, beside the looks. */
export function ownChangesBeside(looks: string): string {
	return join(dirname(looks), "own-changes");
}

/** The folder an owner's record is kept in: a quest's id or a session's. */
function ownerFolder(dir: string, owner: string): string {
	return join(dir, owner.replace(/[^\w-]/g, "_"));
}

/** The file one change is kept in, named by its key, so it is kept once. */
function changeFile(key: string): string {
	return `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`;
}

/** The kept change a file holds, or nothing where it is torn. */
function readChange(file: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		// Gone or torn: a file is written whole, so only a write that never
		// finished is torn, and it loses only its own change.
		return undefined;
	}
	if (!isRecord(parsed) || typeof parsed.url !== "string") return undefined;
	return parsed.url === "" ? undefined : parsed.url;
}

/** The files of an owner's record, or none where it keeps nothing yet. */
function changeFiles(folder: string): string[] {
	try {
		return readdirSync(folder)
			.filter((name) => name.endsWith(".json"))
			.sort();
	} catch {
		// No record yet: nothing proposed under this owner.
		return [];
	}
}

/**
 * Keep `urls` as proposed under `owner`, a file a change, beside what
 * it already holds, each as first spelled: one kept whole already is
 * left as it is, and one that names no change (`namesChange`) never
 * kept. Nothing when `owner` is empty. A change that can't be written
 * doesn't stop the rest; the first such error is thrown once they are
 * all tried.
 */
export function keepProposed(
	dir: string,
	owner: string,
	urls: readonly string[],
): void {
	if (owner.trim() === "" || urls.length === 0) return;
	const folder = ownerFolder(dir, owner);
	let failed: unknown;
	for (const url of urls) {
		const key = proposedKey(url);
		if (!namesChange(key)) continue;
		const file = join(folder, changeFile(key));
		if (readChange(file) !== undefined) continue;
		try {
			writeWhole(
				file,
				`${JSON.stringify({ v: RECORD_VERSION, url: url.trim() })}\n`,
			);
		} catch (error) {
			failed ??= error;
		}
	}
	if (failed !== undefined) throw failed;
}

/**
 * Carry what `from` kept to `to`, as a session rolled over into a
 * fresh log under a new id carries on as the same peer: a session with
 * no quest keeps its record under its own id, which the rollover
 * replaces. Each rollover carries it on, so a chain of them keeps it.
 * A change `to` already keeps is left as it is, never rewritten.
 */
export function carryProposed(dir: string, from: string, to: string): void {
	if (from.trim() === "" || to.trim() === "" || from === to) return;
	const source = ownerFolder(dir, from);
	const names = changeFiles(source);
	if (names.length === 0) return;
	const target = ownerFolder(dir, to);
	mkdirSync(target, { recursive: true });
	const kept = new Set(changeFiles(target));
	for (const name of names) {
		if (kept.has(name)) continue;
		copyFileSync(
			join(source, name),
			join(target, name),
			constants.COPYFILE_EXCL,
		);
	}
}

/** The URLs kept as proposed under any of `owners`. */
export function keptProposed(
	dir: string,
	owners: readonly (string | undefined)[],
): string[] {
	return owners
		.filter((owner): owner is string => !!owner && owner.trim() !== "")
		.flatMap((owner) => {
			const folder = ownerFolder(dir, owner);
			return changeFiles(folder).flatMap(
				(name) => readChange(join(folder, name)) ?? [],
			);
		});
}

/** What to do instead of pointing the person at a change his sessions put up. */
const OWN_CHANGE_INSTEAD =
	"The person reviews no change his sessions put up (Joel, 24 November: review it yourself, take it out of draft and ask for review when you are comfortable with it). Have a council read it, fix what holds, mark it ready and ask its reviewers with review_offer; what only he can decide goes to him as a question, through mesh_send to person, saying what to decide in words rather than asking anyone to put the change on his look list.";

/** What a session is told when it points the person at its own change. */
export const OWN_CHANGE_REFUSED = `This session or its quest proposed that change. ${OWN_CHANGE_INSTEAD}`;

/**
 * Why a look said as `kind` is refused for what its target's host said
 * of who wrote it, or nothing when it may go up. A change the signed-in
 * account wrote is the person's own account's, which every agent
 * proposes under, so it is refused whichever session put it up. One a
 * host claims but can't say the author of is refused too, since it may
 * be his; so is a pull request look nothing answered for. A page no
 * host claims, or someone else's change, goes up.
 */
export function authoredRefusal(
	authored: Authored,
	kind: string,
): string | undefined {
	switch (authored.by) {
		case "signed-in":
			return `${authored.author} wrote that change, the account every one of the person's sessions proposes under. ${OWN_CHANGE_INSTEAD}`;
		case "unknown":
			return `Its host couldn't say who wrote that change (${authored.why}), and a change his own account wrote never goes on his look list. ${OWN_CHANGE_INSTEAD}`;
		case "unanswered":
			return kind === "pr"
				? `Nothing could say in time who wrote that change, and a change his own account wrote never goes on his look list. ${OWN_CHANGE_INSTEAD}`
				: undefined;
		case "other":
		case "no-change":
			return undefined;
	}
}
