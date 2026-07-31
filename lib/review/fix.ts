/**
 * Findings somebody decided to fix rather than say.
 *
 * A review produces two kinds of conclusion, and only one of them is a
 * remark. The other is work: a finding you agree with on your own
 * change is not something to post, it is something to go and do. This
 * is where those wait.
 *
 * The walk is deliberately not autonomous. `next` says what to work on
 * and nothing else; the editing, the checking and the commit happen in
 * the caller's own loop, where a person can interrupt at any point.
 * Then `record` says what became of it. A queue that applied its own
 * fixes would be a queue nobody could stop halfway.
 *
 * Nothing is ever removed. A fix that was abandoned stays with the
 * reason it was abandoned, because somebody deciding a finding was
 * wrong is a judgement worth reading back, and a queue that forgets
 * its refusals will offer the same finding again next week.
 *
 * Two kinds of thing land here, and for a while only one of them
 * could. A finding is something a reviewer raised, ours or a model's.
 * A thread is somebody else's remark on our change, waiting for an
 * answer, and working through those is the commonest review journey
 * there is: it is what a person does on the morning after a review.
 * A queue that held only findings could not represent that day at
 * all, so it was a worklist for the rarer half of the work.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChangeRef } from "./change.js";
import type { Finding } from "./finding.js";
import { changeKey } from "./keys.js";

/** What became of a queued fix. */
export type FixOutcome =
	| { kind: "committed"; commit: string }
	| { kind: "skipped"; reason: string }
	/**
	 * Answered in the conversation, with no code change.
	 *
	 * Only a thread can end this way, and it is not a skip. A remark
	 * answered by explaining why the code is as it is has been dealt
	 * with, and recording it as skipped would put it in the same bucket
	 * as one nobody got to.
	 */
	| { kind: "answered"; reply: string };

/**
 * What a queued item is about.
 *
 * A discriminated union rather than two optional fields, so a reader
 * cannot forget to check which one it has. The two need different
 * things done to them: a finding is closed by a commit, a thread is
 * closed by an answer and often a commit as well.
 */
export type FixSubject =
	| { kind: "finding"; finding: Finding }
	| { kind: "thread"; thread: QueuedThread };

/**
 * The part of a thread worth carrying into the queue.
 *
 * Flattened rather than holding the whole {@link Thread}, because a
 * queue entry is read weeks later and the live thread will have moved
 * on. What is kept is what a person needs to recognise the item
 * without fetching anything: who said it, where, and what they said.
 */
export interface QueuedThread {
	/** Provider-scoped id, so the answer can be posted to it later. */
	id: string;
	/** Who opened it, when the provider says. */
	author?: string;
	/** Where it attaches, as a path and line when it has one. */
	where?: string;
	/** The opening remark, which is what is being answered. */
	said: string;
}

/** One item on the queue. */
export interface QueuedFix {
	/** Stable within a change, and what `record` is called with. */
	findingId: number;
	/**
	 * What the item is about.
	 *
	 * Optional only for the sake of ledgers written before threads
	 * could be queued; {@link subjectOf} fills it in from the older
	 * shape rather than making every reader handle both.
	 */
	subject?: FixSubject;
	/**
	 * The finding, as the first version of this file stored it.
	 *
	 * Kept so an existing queue still reads. Nothing writes it now.
	 */
	finding?: Finding;
	/** What whoever queued it knew about how to fix it. */
	note?: string;
	/** Absent while it is still pending. */
	outcome?: FixOutcome;
}

/**
 * What an entry is about, however old the entry is.
 *
 * The migration lives here rather than in a one-shot rewrite of every
 * file on disk. A queue is small, read often and written rarely, so
 * adapting on read costs nothing and cannot half-finish. Returns
 * undefined only for an entry that carries neither, which is a
 * corrupt record rather than an old one.
 */
export function subjectOf(entry: QueuedFix): FixSubject | undefined {
	if (entry.subject !== undefined) return entry.subject;
	if (entry.finding !== undefined) {
		return { kind: "finding", finding: entry.finding };
	}
	return undefined;
}

/** A one-line description of what a queued item is, for a listing. */
export function describeSubject(entry: QueuedFix): string {
	const subject = subjectOf(entry);
	if (subject === undefined) return "an item with nothing recorded on it";
	if (subject.kind === "finding") return subject.finding.subject;
	const { thread } = subject;
	const who = thread.author === undefined ? "somebody" : thread.author;
	const where = thread.where === undefined ? "" : ` on ${thread.where}`;
	return `${who}${where}: ${thread.said}`;
}

/** How the queue stands. */
export interface FixTally {
	pending: number;
	committed: number;
	skipped: number;
	/** Threads answered in the conversation, with no code change. */
	answered: number;
}

/** The queue of fixes for a change. */
export interface FixQueue {
	queue(change: ChangeRef, finding: Finding, note?: string): Promise<void>;
	/**
	 * Put somebody's remark on the worklist.
	 *
	 * Numbered in the same sequence as findings, because a person
	 * working through a morning's review does not care which half of
	 * the surface an item came from, and two numbering schemes on one
	 * change would make "item 4" ambiguous out loud. Answers the number
	 * it was given.
	 */
	queueThread(
		change: ChangeRef,
		thread: QueuedThread,
		note?: string,
	): Promise<number>;
	/** The oldest fix with no outcome yet. */
	next(change: ChangeRef): Promise<QueuedFix | undefined>;
	record(
		change: ChangeRef,
		findingId: number,
		outcome: FixOutcome,
	): Promise<void>;
	/** Everything ever queued, settled or not, in order. */
	list(change: ChangeRef): Promise<QueuedFix[]>;
	tally(change: ChangeRef): Promise<FixTally>;
}

/** What one change's file holds. */
interface Ledger {
	fixes: QueuedFix[];
}

/** A queue kept on disk, one file per change. */
export function createFixQueue(root: string): FixQueue {
	async function read(change: ChangeRef): Promise<Ledger> {
		try {
			const raw = await readFile(join(root, fileFor(change)), "utf8");
			const parsed: unknown = JSON.parse(raw);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"fixes" in parsed &&
				Array.isArray(parsed.fixes)
			) {
				return { fixes: parsed.fixes as QueuedFix[] };
			}
		} catch {
			// No file, or one nothing can read. Either way this change has
			// nothing queued, which is an answer rather than a failure.
		}
		return { fixes: [] };
	}

	async function write(change: ChangeRef, ledger: Ledger): Promise<void> {
		await mkdir(root, { recursive: true });
		await writeFile(
			join(root, fileFor(change)),
			JSON.stringify(ledger, null, 2),
			"utf8",
		);
	}

	return {
		async queue(change, finding, note) {
			const ledger = await read(change);
			if (ledger.fixes.some((one) => one.findingId === finding.id)) {
				// Queued twice means fixed twice, or worse, fixed once and
				// then reported as still outstanding.
				throw new Error(
					`Finding ${finding.id} is already queued for fixing on ${change.label}.`,
				);
			}
			ledger.fixes.push({
				findingId: finding.id,
				subject: { kind: "finding", finding },
				...(note === undefined || note.trim() === ""
					? {}
					: { note: note.trim() }),
			});
			await write(change, ledger);
		},

		async queueThread(change, thread, note) {
			const ledger = await read(change);
			const already = ledger.fixes.find((one) => {
				const subject = subjectOf(one);
				return subject?.kind === "thread" && subject.thread.id === thread.id;
			});
			if (already) {
				// Same reasoning as a finding queued twice, and more likely
				// here: a caller sweeping unresolved threads will sweep the
				// same ones again tomorrow.
				throw new Error(
					`That thread is already on the worklist for ${change.label}, as item ${already.findingId}.`,
				);
			}
			// One sequence for both kinds. Findings carry numbers minted by
			// the finding store, so this takes the next number above
			// everything present rather than counting its own entries,
			// which would collide the moment a finding was queued after it.
			const id =
				ledger.fixes.reduce((top, one) => Math.max(top, one.findingId), 0) + 1;
			ledger.fixes.push({
				findingId: id,
				subject: { kind: "thread", thread },
				...(note === undefined || note.trim() === ""
					? {}
					: { note: note.trim() }),
			});
			await write(change, ledger);
			return id;
		},

		async next(change) {
			const { fixes } = await read(change);
			// Insertion order, so the same queue read twice is the same
			// queue. A reader who saw a list and then asked for the next
			// one should get the one they were looking at.
			return fixes.find((one) => one.outcome === undefined);
		},

		async record(change, findingId, outcome) {
			const ledger = await read(change);
			const held = ledger.fixes.find((one) => one.findingId === findingId);
			if (held === undefined) {
				throw new Error(
					`Finding ${findingId} is not queued for fixing on ${change.label}, so there is nothing to record against it.`,
				);
			}
			if (held.outcome !== undefined) {
				// The first answer is the true one. Overwriting would let a
				// later mistake erase a commit that really happened.
				throw new Error(
					`Finding ${findingId} was already recorded as ${held.outcome.kind}. Reopen it by queueing the follow-up as its own finding.`,
				);
			}
			held.outcome = outcome;
			await write(change, ledger);
		},

		async list(change) {
			return (await read(change)).fixes;
		},

		async tally(change) {
			const { fixes } = await read(change);
			return {
				pending: fixes.filter((one) => one.outcome === undefined).length,
				committed: fixes.filter((one) => one.outcome?.kind === "committed")
					.length,
				skipped: fixes.filter((one) => one.outcome?.kind === "skipped").length,
				answered: fixes.filter((one) => one.outcome?.kind === "answered")
					.length,
			};
		},
	};
}

/**
 * File name for a change's queue.
 *
 * Folded to something safe, so a change key carrying a slash or a pair
 * of dots cannot name a path outside the queue directory.
 */
function fileFor(change: ChangeRef): string {
	const safe = changeKey(change)
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.replace(/^\.+/, "_");
	return `${safe}.json`;
}
