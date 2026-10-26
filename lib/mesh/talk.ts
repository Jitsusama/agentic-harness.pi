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
 * - `came`: what came of it later, such as a plan concluded.
 *
 * Talks are kept for RETAIN_DAYS or the newest RETAIN_TALKS of an
 * inbox, whichever keeps more, and pruned when a talk is opened.
 */

import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";

/** How long a talk is kept, at the least. */
export const RETAIN_DAYS = 90;
/** How many of an inbox's newest talks are kept, however old. */
export const RETAIN_TALKS = 500;

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
	  }
	| { readonly stage: "reading"; readonly after: string }
	| { readonly stage: "replying"; readonly text: string }
	| { readonly stage: "replied"; readonly text: string }
	| { readonly stage: "failed"; readonly why: string }
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
