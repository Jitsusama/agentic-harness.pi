/**
 * What a session points the person at to look at: a pull request, a
 * page, a file, a diff, a terminal. Kept for the launcher's look list,
 * where the person opens each in its place or clears it.
 *
 * Joel, 8 November, of things sessions want him to see: nothing opens by
 * itself, "but we need to make sure they don't time out and don't get
 * confused with other things". So a look is a record of its own, one
 * file each in a folder of its own, apart from notices and Needs You,
 * and nothing here ever takes one away: it stays, through reboots, until
 * the launcher marks it opened or cleared, or deletes it. Each says whose
 * it is, what it is and why he should look.
 *
 * One file a look, so sessions pointing at once never race on a shared
 * file. A look at the same thing from the same session replaces its
 * first, so pointing again brings it to the top rather than doubling it.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeWhole } from "../internal/write-whole.ts";

/** The kinds of thing a look opens, each in its own place. */
export const LOOK_KINDS = ["pr", "page", "file", "diff", "terminal"] as const;

/** What a look opens. */
export type LookKind = (typeof LOOK_KINDS)[number];

/**
 * Where a look stands: waiting for the person, done with by them, or
 * resolved without them, since what it pointed at merged or closed.
 */
export type LookState = "waiting" | "opened" | "cleared" | "resolved";

/**
 * How a look's change was resolved without the person: it merged or
 * closed, or their own account reviewed it on GitHub (looks-github.ts).
 */
export type LookResolution = "merged" | "closed" | `reviewed by ${string}`;

/** One thing a session points the person at. */
export interface Look {
	readonly v: 1;
	/** Stable for one session's look at one thing. */
	readonly id: string;
	/** When it was pointed at, as an ISO time. */
	readonly at: string;
	/** The session pointing, and the address it signs with. */
	readonly session: string;
	readonly address?: string;
	/** The quest it has loaded. */
	readonly quest?: string;
	readonly kind: LookKind;
	/**
	 * What opens: a URL for a pull request or a page, an absolute path
	 * for a file, a diff's file or URL, or a session id for a terminal.
	 */
	readonly target: string;
	/** What it is, in a few words. */
	readonly title: string;
	/** Why the person should look, in a sentence. */
	readonly why: string;
	/** Waiting until the launcher says the person opened or cleared it. */
	readonly state: LookState;
	/** How it resolved, and when, once its change merged or closed. */
	readonly how?: LookResolution;
	readonly resolvedAt?: string;
}

/** What a session says to point the person at something. */
export interface Pointing {
	readonly kind: LookKind;
	readonly target: string;
	readonly title: string;
	readonly why: string;
}

/** Whose a look is. */
export interface Pointer {
	readonly session: string;
	readonly address?: string;
	readonly quest?: string;
}

/** Whether a value names a look's kind. */
export function isLookKind(value: unknown): value is LookKind {
	return typeof value === "string" && LOOK_KINDS.some((kind) => kind === value);
}

/** The id one session's look at one thing keeps. */
export function lookId(
	session: string,
	kind: LookKind,
	target: string,
): string {
	return createHash("sha256")
		.update(`${session}\0${kind}\0${target}`)
		.digest("hex")
		.slice(0, 16);
}

/** Why a pointing can't be kept, or nothing when it can. */
export function refusalOf(pointing: Pointing): string | undefined {
	if (pointing.target.trim() === "") return "A look needs what it opens.";
	if (pointing.title.trim() === "")
		return "A look needs what it is, in a few words.";
	if (pointing.why.trim() === "") {
		return "A look needs why the person should look, so it isn't mistaken for something else.";
	}
	if (
		(pointing.kind === "pr" || pointing.kind === "page") &&
		!/^https?:\/\//.test(pointing.target)
	) {
		return `A ${pointing.kind === "pr" ? "pull request" : "page"} opens by its URL.`;
	}
	if (pointing.kind === "file" && !pointing.target.startsWith("/")) {
		return "A file opens by its absolute path.";
	}
	return undefined;
}

/**
 * Keep a look for the person in `dir`, in place of this session's
 * earlier look at the same thing; answers the look kept.
 */
export function pointAt(
	dir: string,
	pointing: Pointing,
	pointer: Pointer,
	now: Date = new Date(),
): Look {
	const look: Look = {
		v: 1,
		id: lookId(pointer.session, pointing.kind, pointing.target),
		at: now.toISOString(),
		session: pointer.session,
		...(pointer.address ? { address: pointer.address } : {}),
		...(pointer.quest ? { quest: pointer.quest } : {}),
		kind: pointing.kind,
		target: pointing.target.trim(),
		title: pointing.title.trim(),
		why: pointing.why.trim(),
		state: "waiting",
	};
	writeWhole(
		join(dir, `${look.id}.json`),
		`${JSON.stringify(look, null, 2)}\n`,
	);
	return look;
}

/** Whether a value read from a look's file is a look. */
function isLook(value: unknown): value is Look {
	if (typeof value !== "object" || value === null) return false;
	return (
		"id" in value &&
		typeof value.id === "string" &&
		"at" in value &&
		typeof value.at === "string" &&
		"kind" in value &&
		isLookKind(value.kind) &&
		"target" in value &&
		typeof value.target === "string"
	);
}

/** A change's URL as compared: no trailing slash, fragment or query. */
function urlKey(url: string): string {
	return url
		.trim()
		.replace(/[?#].*$/, "")
		.replace(/\/+$/, "");
}

/** The URL a look at a change opens, read to its change: a PR's tabs are the PR. */
function changeKey(target: string): string {
	return urlKey(target).replace(
		/(\/pull\/\d+)\/(?:files|commits|checks|changes)(?:\/.*)?$/,
		"$1",
	);
}

/**
 * Mark every waiting look at the change at `url` resolved, since it
 * merged or closed, so the person isn't asked to look at what no longer
 * needs them (Joel, 8 November). Answers how many it marked. A look the
 * person already opened or cleared is left as they left it.
 */
export function resolveLooks(
	dir: string,
	url: string,
	how: LookResolution,
	now: Date = new Date(),
): number {
	const key = changeKey(url);
	if (key === "") return 0;
	let marked = 0;
	for (const look of looksIn(dir)) {
		if (look.state !== "waiting") continue;
		if (look.kind !== "pr" && look.kind !== "diff") continue;
		if (changeKey(look.target) !== key) continue;
		const resolved: Look = {
			...look,
			state: "resolved",
			how,
			resolvedAt: now.toISOString(),
		};
		writeWhole(
			join(dir, `${look.id}.json`),
			`${JSON.stringify(resolved, null, 2)}\n`,
		);
		marked++;
	}
	return marked;
}

/** Every look kept in `dir`, newest first; none for a folder not there. */
export function looksIn(dir: string): Look[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		// No folder yet is no looks yet.
		return [];
	}
	return names
		.flatMap((name) => {
			try {
				const value: unknown = JSON.parse(
					readFileSync(join(dir, name), "utf8"),
				);
				return isLook(value) ? [value] : [];
			} catch {
				// A file being replaced is read on the next look.
				return [];
			}
		})
		.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
