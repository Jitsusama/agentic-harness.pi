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
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChangeRef } from "./change.js";
import type { Finding } from "./finding.js";
import { changeKey } from "./keys.js";

/** What became of a queued fix. */
export type FixOutcome =
	| { kind: "committed"; commit: string }
	| { kind: "skipped"; reason: string };

/** One finding on the queue. */
export interface QueuedFix {
	findingId: number;
	/** The whole finding, so a later session needs nothing else. */
	finding: Finding;
	/** What whoever queued it knew about how to fix it. */
	note?: string;
	/** Absent while it is still pending. */
	outcome?: FixOutcome;
}

/** How the queue stands. */
export interface FixTally {
	pending: number;
	committed: number;
	skipped: number;
}

/** The queue of fixes for a change. */
export interface FixQueue {
	queue(change: ChangeRef, finding: Finding, note?: string): Promise<void>;
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
				finding,
				...(note === undefined || note.trim() === ""
					? {}
					: { note: note.trim() }),
			});
			await write(change, ledger);
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
