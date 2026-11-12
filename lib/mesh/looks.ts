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
 * file. A look at the same thing from the same session, or another on
 * its quest, replaces the first in its place rather than doubling it: a
 * change's tabs and diffs are the change, a page's fragment is the page,
 * and looks a session sets on one thread fold whatever they open. Titles
 * never fold, since sessions reword them (2RCBOJ, 12 November).
 *
 * Joel, 12 November, of a list that had held 45: "how many of those are
 * actually useful to me as a human?" So a look says whether it asks for
 * something back. One that only shows leaves once he has opened it, and
 * expires a day after it was pointed at, its owner told; one that asks
 * lasts until it is answered, taken back, or its quest ends. Its owner
 * takes it back whether he has opened it or not, and so can any later
 * session on its quest.
 *
 * Joel, 11 November: "anything that is going to fight for my attention
 * is easy for me to engage with, even if i engage with it later. if it
 * is no longer applicable because i took too long and things have
 * changed, it should disappear." So a look carries its own context in
 * his words, what it is, why and what he's asked, and refuses the
 * agents' own talk (message and quest ids, peer addresses, paths, code);
 * and its session takes it back, or its quest's end does, once it no
 * longer applies.
 *
 * A look that asks for a word back names its choices, so the launcher
 * can answer it where he is (2RCBOJ, 12 November): the launcher steers
 * the pick to the session, which answers the look here and tells its
 * agent. Only sessions write a look's file once it is kept, apart from
 * the launcher marking it opened or cleared.
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
export type LookState =
	| "waiting"
	| "opened"
	| "cleared"
	| "resolved"
	| "expired";

/** The states in which a look still stands on the person's list. */
const STANDING: readonly LookState[] = ["waiting", "opened"];

/** How long a look that asks nothing back stays on the list. */
export const SHOWING_LASTS_MS = 24 * 60 * 60 * 1000;

/** An ask that wants nothing back: "Nothing, just to see". */
const ONLY_TO_SEE =
	/^\s*(?:nothing|none|no action|fyi|for your information)\b|\b(?:just|only) (?:to|so you) (?:see|read|know|look)\b/i;

/**
 * How a look was resolved without the person: its change merged or
 * closed, or their own account reviewed it on GitHub (looks-github.ts);
 * its session took it back; or the quest it was for ended.
 */
export type LookResolution =
	| "merged"
	| "closed"
	| `reviewed by ${string}`
	| "taken back"
	| "replaced"
	| "seen"
	| "its quest ended"
	| `answered: ${string}`;

/** The most words a look's why may run to: a sentence, read at a glance. */
export const WHY_WORDS = 40;

/** The most words a look's ask may run to. */
export const ASK_WORDS = 30;

/** The most choices a look offers, so its row holds them all. */
export const MOST_CHOICES = 4;

/** The most words a choice runs to: a button's label. */
export const CHOICE_WORDS = 4;

/** One answer a look offers, as the launcher shows it and steers it back. */
export interface LookChoice {
	readonly value: string;
	readonly label: string;
}

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
	/**
	 * What the person is asked to do, with the choices, or that it is
	 * only to see; none on a look kept before looks carried one.
	 */
	readonly ask?: string;
	/** The answers it offers, for a look that asks for a word back. */
	readonly choices?: readonly LookChoice[];
	/**
	 * Whether it wants something back from the person; a look kept before
	 * looks said counts as asking.
	 */
	readonly asks?: boolean;
	/** When it stops being worth his time, as an ISO time; none, never. */
	readonly expiresAt?: string;
	/** The thread its session set, folding its looks whatever they open. */
	readonly thread?: string;
	/** Waiting until the launcher says the person opened or cleared it. */
	readonly state: LookState;
	/** How it resolved, and when, once its change merged or closed. */
	readonly how?: LookResolution;
	readonly resolvedAt?: string;
	/** The choice's value the person answered with, and when. */
	readonly answer?: string;
	readonly answeredAt?: string;
}

/** What a session says to point the person at something. */
export interface Pointing {
	readonly kind: LookKind;
	readonly target: string;
	readonly title: string;
	readonly why: string;
	readonly ask: string;
	/** The labels of the answers it offers, when it asks for a word back. */
	readonly choices?: readonly string[];
	/** A thread of the session's, such as a question's id, to fold on. */
	readonly thread?: string;
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

/** The id a new look keeps: its quest's, or else its session's, at what it folds on. */
function lookId(pointer: Pointer, fold: string): string {
	return createHash("sha256")
		.update(`${pointer.quest ?? pointer.session}\0${fold}`)
		.digest("hex")
		.slice(0, 16);
}

/**
 * What a look at `kind` and `target` folds on: a change's own URL for a
 * look at it or its diff, tabs and fragments aside; a page without its
 * fragment; anything else as it opens.
 */
function foldOf(kind: LookKind, target: string): string {
	const trimmed = target.trim();
	const url = /^https?:\/\//.test(trimmed);
	if (url && (kind === "pr" || kind === "diff"))
		return `change ${changeKey(trimmed)}`;
	if (url && kind === "page")
		return `page ${trimmed.replace(/#.*$/, "").replace(/\/+$/, "")}`;
	return `${kind} ${trimmed}`;
}

/** Whether `look` is `pointer`'s to replace, take back or expire: its session's, or its quest's. */
export function heldBy(look: Look, pointer: Pointer): boolean {
	return (
		look.session === pointer.session ||
		(pointer.quest !== undefined && look.quest === pointer.quest)
	);
}

/** Whether `look` still stands on the person's list. */
function stands(look: Look): boolean {
	return STANDING.includes(look.state);
}

/** Whether a pointing wants something back: choices, or an ask beyond seeing. */
function asksBack(pointing: Pointing): boolean {
	return (pointing.choices?.length ?? 0) > 0 || !ONLY_TO_SEE.test(pointing.ask);
}

/** Why a pointing can't be kept, or nothing when it can. */
export function refusalOf(pointing: Pointing): string | undefined {
	if (pointing.target.trim() === "") return "A look needs what it opens.";
	if (pointing.title.trim() === "")
		return "A look needs what it is, in a few words.";
	if (pointing.why.trim() === "") {
		return "A look needs why the person should look, so it isn't mistaken for something else.";
	}
	if (pointing.ask.trim() === "") {
		return "A look needs what the person is asked to do and the choices, or that it is only to see.";
	}
	const talk = agentTalkIn(pointing);
	if (talk) return talk;
	const choices = choiceRefusal(pointing.choices ?? []);
	if (choices) return choices;
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
 * The agents' own talk in what a look says, which the person can't place
 * when he reaches it later (Joel, 11 November: "it is too hard for me to
 * parse"), or nothing when it reads as written for him.
 */
function agentTalkIn(pointing: Pointing): string | undefined {
	const said = [pointing.title, pointing.why, pointing.ask];
	const plain =
		"Write it for the person, in plain words that say what it means for him.";
	for (const [pattern, what] of AGENT_TALK) {
		if (said.some((text) => pattern.test(text)))
			return `A look names ${what}, which the person can't place. ${plain}`;
	}
	if (/(?:^|\s)(?:~\/|\/[\w.-]+\/)/.test(`${pointing.why} ${pointing.ask}`)) {
		return `A look's why and ask name no path: what opens is its target. ${plain}`;
	}
	if (wordsIn(pointing.why) > WHY_WORDS)
		return `A look's why is a sentence, at most ${WHY_WORDS} words.`;
	if (wordsIn(pointing.ask) > ASK_WORDS)
		return `A look's ask is at most ${ASK_WORDS} words.`;
	return undefined;
}

/** Why a look's choices can't be offered, or nothing when they can. */
function choiceRefusal(choices: readonly string[]): string | undefined {
	if (choices.length > MOST_CHOICES)
		return `A look offers at most ${MOST_CHOICES} choices.`;
	const labels = choices.map((one) => one.trim());
	if (labels.some((one) => one === "")) return "A look's choice needs words.";
	if (new Set(labels.map((one) => one.toLowerCase())).size < labels.length)
		return "A look's choices each say something different.";
	if (labels.some((one) => wordsIn(one) > CHOICE_WORDS))
		return `A look's choice is a label, at most ${CHOICE_WORDS} words.`;
	for (const [pattern, what] of AGENT_TALK) {
		if (labels.some((one) => pattern.test(one)))
			return `A look's choice names ${what}, which the person can't place.`;
	}
	return undefined;
}

/** What gives the agents' talk away, and what each is called. */
const AGENT_TALK: readonly (readonly [RegExp, string])[] = [
	[/\[[0-9a-f]{8}\]/, "a mesh message's id"],
	[/\b[A-Z]{4}-\d{8}-[A-Z0-9]{6}\b/, "a quest's or document's id"],
	// Six capitals or digits, as a session signs: WCJQSG, 85PKB2.
	[/\b(?=[A-Z0-9]{0,5}[A-Z])[A-Z0-9]{6}\b/, "a session's address"],
	[/`/, "code"],
];

/** How many words `text` runs to. */
function wordsIn(text: string): number {
	return text.split(/\s+/).filter((word) => word !== "").length;
}

/**
 * Keep a look for the person in `dir`, in the place of the earliest look
 * standing that this session or its quest pointed at the same thing or
 * on the same thread; any other such look resolves as replaced. Answers
 * the look kept.
 */
export function pointAt(
	dir: string,
	pointing: Pointing,
	pointer: Pointer,
	now: Date = new Date(),
): Look {
	const fold = foldOf(pointing.kind, pointing.target);
	const thread = pointing.thread?.trim() || undefined;
	const folded = looksIn(dir).filter(
		(one) =>
			stands(one) &&
			heldBy(one, pointer) &&
			(foldOf(one.kind, one.target) === fold ||
				(thread !== undefined && one.thread === thread)),
	);
	// Newest first, so the earliest place is the last.
	const place = folded.at(-1);
	for (const one of folded.slice(0, -1))
		markResolvedLook(dir, one, "replaced", now);
	const asks = asksBack(pointing);
	const look: Look = {
		v: 1,
		id: place?.id ?? lookId(pointer, thread ? `thread ${thread}` : fold),
		at: place?.at ?? now.toISOString(),
		session: pointer.session,
		...(pointer.address ? { address: pointer.address } : {}),
		...(pointer.quest ? { quest: pointer.quest } : {}),
		kind: pointing.kind,
		target: pointing.target.trim(),
		title: pointing.title.trim(),
		why: pointing.why.trim(),
		ask: pointing.ask.trim(),
		...(pointing.choices?.length
			? {
					choices: pointing.choices.map((one) => ({
						value: one.trim(),
						label: one.trim(),
					})),
				}
			: {}),
		asks,
		...(asks
			? {}
			: {
					expiresAt: new Date(now.getTime() + SHOWING_LASTS_MS).toISOString(),
				}),
		...(thread ? { thread } : {}),
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
 * Mark every standing look at the change at `url` resolved, since it
 * merged or closed, so the person isn't asked to look at what no longer
 * needs them (Joel, 8 November). Answers how many it marked. A look the
 * person cleared is left as they left it.
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
		if (!stands(look)) continue;
		if (look.kind !== "pr" && look.kind !== "diff") continue;
		if (changeKey(look.target) !== key) continue;
		markResolvedLook(dir, look, how, now);
		marked++;
	}
	return marked;
}

/**
 * Take back every standing look of `pointer`'s session or quest at what
 * `kind` and `target` fold on, since it no longer applies, opened or not;
 * answers whether there was one to take back. A look the person cleared
 * is left as they left it.
 */
export function withdrawLook(
	dir: string,
	pointer: Pointer,
	kind: LookKind,
	target: string,
	now: Date = new Date(),
): boolean {
	const fold = foldOf(kind, target);
	const taken = looksIn(dir).filter(
		(one) =>
			stands(one) &&
			heldBy(one, pointer) &&
			foldOf(one.kind, one.target) === fold,
	);
	for (const one of taken) markResolvedLook(dir, one, "taken back", now);
	return taken.length > 0;
}

/**
 * Mark every standing look past its time that `owns` says is this
 * session's to expire, so what no longer needs the person leaves his
 * list; answers the looks it expired, for their owner to be told.
 */
export function expireLooks(
	dir: string,
	owns: (look: Look) => boolean,
	now: Date = new Date(),
): Look[] {
	const due = looksIn(dir).filter(
		(one) =>
			stands(one) &&
			one.expiresAt !== undefined &&
			Date.parse(one.expiresAt) <= now.getTime() &&
			owns(one),
	);
	return due.map((one) => {
		const expired: Look = {
			...one,
			state: "expired",
			resolvedAt: now.toISOString(),
		};
		writeLook(dir, expired);
		return expired;
	});
}

/**
 * Mark every look the person has opened that asks nothing back resolved,
 * since opening it was all it wanted; answers how many it marked. A
 * look kept before looks said whether they ask stays, as asking.
 */
export function leaveSeenLooks(dir: string, now: Date = new Date()): number {
	const seen = looksIn(dir).filter(
		(one) => one.state === "opened" && one.asks === false,
	);
	for (const one of seen) markResolvedLook(dir, one, "seen", now);
	return seen.length;
}

/**
 * Mark every standing look for a quest `ended` says has ended resolved,
 * since what a quest asked of the person ends with it. Answers how many
 * it marked.
 */
export function resolveLooksOfQuests(
	dir: string,
	ended: (quest: string) => boolean,
	now: Date = new Date(),
): number {
	let marked = 0;
	for (const look of looksIn(dir)) {
		if (!stands(look) || look.quest === undefined) continue;
		if (!ended(look.quest)) continue;
		markResolvedLook(dir, look, "its quest ended", now);
		marked++;
	}
	return marked;
}

/**
 * Answer the standing look `id` with the choice whose value is `value`,
 * as the person picked it from the launcher: it resolves, saying what he
 * answered. Answers the look as answered, or nothing when it is gone,
 * no longer standing, or offers no such choice.
 */
export function answerLook(
	dir: string,
	id: string,
	value: string,
	now: Date = new Date(),
): Look | undefined {
	const look = looksIn(dir).find((one) => one.id === id);
	if (!look || !stands(look)) return undefined;
	const choice = look.choices?.find((one) => one.value === value);
	if (!choice) return undefined;
	return markResolvedLook(dir, look, `answered: ${choice.label}`, now, {
		answer: choice.value,
		answeredAt: now.toISOString(),
	});
}

/** Write `look` back resolved, `how`, with what else it now says. */
function markResolvedLook(
	dir: string,
	look: Look,
	how: LookResolution,
	now: Date,
	also: Partial<Pick<Look, "answer" | "answeredAt">> = {},
): Look {
	const resolved: Look = {
		...look,
		...also,
		state: "resolved",
		how,
		resolvedAt: now.toISOString(),
	};
	writeLook(dir, resolved);
	return resolved;
}

/** Write `look` whole to its file in `dir`. */
function writeLook(dir: string, look: Look): void {
	writeWhole(
		join(dir, `${look.id}.json`),
		`${JSON.stringify(look, null, 2)}\n`,
	);
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
