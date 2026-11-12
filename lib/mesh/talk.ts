/**
 * Talks: what became of each thing the person said through a steer
 * inbox, kept as a file of its own so the desktop can show a talk as
 * it goes and its history after the session that answered has ended.
 *
 * A steer that carries an `id` opens a talk. Its events go one JSON
 * line each, every one with `at`, into `<inbox>/replies/<id>.jsonl`:
 *
 * - `delivered`: the session took it, with the person's words;
 * - `reading`: the session is working on it, and on which step;
 * - `replying`: the reply so far, while it is written;
 * - `replied`: the whole reply, or `failed` with why there is none;
 * - `came`: what came of it later, such as a plan concluded;
 * - `read`: the person has read the reply, appended by the desktop
 *   (the agents daemon, for the launcher) with who read it as `by`;
 *   no session writes it;
 * - `over`: the session has moved on from a reply, with `why`: a
 *   newer talk to it was replied, or it ended for good. Carrying on
 *   with its own work is not moving on.
 *
 * A `delivered` keeps `re` when its steer answers an earlier talk in
 * place, so the desktop can show the two as one thread.
 *
 * The shape holds for a reader in another language, such as a Rust
 * one with serde, without a change of schema later: each line is one
 * object tagged by `stage`, with `at` an ISO time; fields are only
 * ever added, never renamed or given another type; a field not said
 * is left out rather than null; and a reader passes over a stage or
 * field it doesn't know. The file is only ever
 * appended to, by the session and by the desktop's `read`.
 *
 * Talks are kept for RETAIN_DAYS or the newest RETAIN_TALKS of an
 * inbox, whichever keeps more, and pruned when a talk is opened.
 */

import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";

/** How long a talk is kept, at the least. */
export const RETAIN_DAYS = 90;
/** How many of an inbox's newest talks are kept, however old. */
export const RETAIN_TALKS = 500;

/** How many of an inbox's newest talks a session looks at to end them. */
const OVER_LOOKS = 50;

const DAY_MS = 24 * 60 * 60 * 1000;
const REPLIES = "replies";
const TALK = ".jsonl";

/** One change in a talk, as its file carries it, less its time. */
export type TalkEvent =
	| {
			readonly stage: "delivered";
			readonly session: string;
			readonly text: string;
			readonly from?: string;
			readonly sentAt?: string;
			readonly re?: string;
	  }
	| { readonly stage: "reading"; readonly after: string }
	| { readonly stage: "replying"; readonly text: string }
	| { readonly stage: "replied"; readonly text: string }
	| { readonly stage: "failed"; readonly why: string }
	| { readonly stage: "read"; readonly by: string }
	| { readonly stage: "over"; readonly why: string }
	| {
			readonly stage: "came";
			readonly what: string;
			readonly ref?: string;
	  };

/**
 * Whether a steer's id can name a talk file: short, and made only of
 * letters, digits, dots, dashes and underscores, so it can never
 * reach outside the replies folder.
 */
export function isTalkId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(value)
	);
}

/** The file a talk's events go in. */
export function talkFile(inbox: string, id: string): string {
	return join(inbox, REPLIES, `${id}${TALK}`);
}

/** Add one event to a talk, stamped with the time it is said. */
export function sayTalk(
	inbox: string,
	id: string,
	event: TalkEvent,
	at: Date = new Date(),
): void {
	mkdirSync(join(inbox, REPLIES), { recursive: true });
	appendFileSync(
		talkFile(inbox, id),
		`${JSON.stringify({ ...event, at: at.toISOString() })}\n`,
	);
}

/** One line of a talk as read back: its stage, its time and the rest. */
export interface TalkLine {
	readonly stage: string;
	readonly at: string;
	readonly [field: string]: unknown;
}

/**
 * A talk's events, read back in the order they were said. A line that
 * is not an object with a `stage` and an `at`, such as one torn by a
 * writer that died mid-line, is passed over; a stage this reader
 * doesn't know is kept, as its writer said it.
 */
export function talkEvents(inbox: string, id: string): TalkLine[] {
	let raw: string;
	try {
		raw = readFileSync(talkFile(inbox, id), "utf8");
	} catch {
		// No such talk: it has no events.
		return [];
	}
	return raw.split("\n").flatMap((line) => {
		const event = lineOf(line);
		return event ? [event] : [];
	});
}

/**
 * Say each talk of a session in an inbox that it replied to, and that
 * isn't over yet, is over, with why; `except` names the talk the
 * session has just answered, which stays as it is. Looks at the
 * newest OVER_LOOKS talks only, since each reply ends those before it.
 * Answers the talks it ended.
 */
export function overTalks(
	inbox: string,
	session: string,
	why: string,
	except?: string,
	at: Date = new Date(),
): string[] {
	const ended: string[] = [];
	for (const id of newestTalks(inbox, OVER_LOOKS)) {
		if (id === except) continue;
		const events = talkEvents(inbox, id);
		const delivered = events.find(({ stage }) => stage === "delivered");
		if (delivered?.session !== session) continue;
		const stages = new Set(events.map(({ stage }) => stage));
		if (!stages.has("replied") || stages.has("over")) continue;
		try {
			sayTalk(inbox, id, { stage: "over", why }, at);
			ended.push(id);
		} catch {
			// A talk that can't be written stays as it was; the next look tries.
		}
	}
	return ended;
}

/** An inbox's talks, newest first, at most `count` of them. */
function newestTalks(inbox: string, count: number): string[] {
	const folder = join(inbox, REPLIES);
	let names: string[];
	try {
		names = readdirSync(folder).filter((name) => name.endsWith(TALK));
	} catch {
		// No talks yet.
		return [];
	}
	return names
		.map((name) => ({ name, at: modified(join(folder, name)) }))
		.sort((a, b) => b.at - a.at)
		.slice(0, count)
		.map(({ name }) => name.slice(0, -TALK.length));
}

function lineOf(line: string): TalkLine | undefined {
	if (line.trim() === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		// Torn or not JSON: not an event.
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	if (!("stage" in parsed && typeof parsed.stage === "string")) {
		return undefined;
	}
	if (!("at" in parsed && typeof parsed.at === "string")) return undefined;
	return { ...parsed, stage: parsed.stage, at: parsed.at };
}

/**
 * Remove an inbox's talks that are both older than RETAIN_DAYS and
 * past its newest RETAIN_TALKS. Answers how many went.
 */
export function pruneTalks(inbox: string, now: number = Date.now()): number {
	const folder = join(inbox, REPLIES);
	let names: string[];
	try {
		names = readdirSync(folder).filter((name) => name.endsWith(TALK));
	} catch {
		// No talks yet: nothing to prune.
		return 0;
	}
	const talks = names
		.map((name) => ({
			path: join(folder, name),
			at: modified(join(folder, name)),
		}))
		.sort((a, b) => b.at - a.at);
	let pruned = 0;
	for (const [rank, talk] of talks.entries()) {
		if (rank < RETAIN_TALKS || now - talk.at < RETAIN_DAYS * DAY_MS) continue;
		try {
			unlinkSync(talk.path);
			pruned += 1;
		} catch {
			// Gone already, or not ours to remove: the next prune tries again.
		}
	}
	return pruned;
}

function modified(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		// Removed while listed: it sorts last and is pruned as gone.
		return 0;
	}
}
