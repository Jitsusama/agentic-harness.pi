/**
 * How the queue keeps what each job it gave up came to: its shell's
 * word and when it said it, appended to the outcome file the rules
 * learn from, in the order the jobs were seen to end, and counted from
 * the moment each is given up, as if written at once.
 */

import { readFileSync, statSync } from "node:fs";
import { movedMain } from "./fetched.ts";
import {
	appendOutcome,
	halveOutcomes,
	type Outcome,
	outcomeOf,
	processOutcomes,
} from "./outcome.ts";
import type { Job } from "./queue.ts";

/** What a queue keeps of the jobs it gave up. */
export interface KeptOutcomes {
	/** Every outcome kept, those still being written among them. */
	recorded(): readonly Outcome[];
	/**
	 * Keeps how `job` ended, seen to at `now`, or with the boot that cut
	 * it off at `cutAt`.
	 */
	remember(job: Job, now: number, cutAt?: number): void;
	/** Settles once every outcome being written has landed. */
	written(): Promise<void>;
}

/**
 * An outcome is looked for this far back in the file before it counts
 * as still being added: far more than end between two keeps.
 */
const ADDED_WITHIN = 64;

/**
 * The outcomes kept in the file at `outcomes`, or none without one,
 * each job's files found by `path`.
 */
export function keptOutcomes(
	outcomes: string | undefined,
	path: (id: string, ending: string) => string,
): KeptOutcomes {
	// Outcomes this session is still adding, by job, which count from the
	// moment their job is given up, as when they were written at once.
	const adding = new Map<string, Outcome>();
	const writing = new Set<Promise<void>>();
	// Each write waits for the one before, so outcomes kept in one keep land
	// in the order they were seen rather than the order the disk answers.
	let lastWrite: Promise<void> = Promise.resolve();

	return {
		recorded() {
			if (!outcomes) return [];
			// The queue is kept every two seconds and the file is up to 2 MiB,
			// so the process reads only what was added since, once for all.
			const read = processOutcomes(outcomes);
			if (adding.size === 0) return read;
			const lately = new Set(
				read.slice(-ADDED_WITHIN).map((outcome) => outcome.id),
			);
			const unwritten = [...adding.values()].filter(
				(outcome) => !lately.has(outcome.id),
			);
			return unwritten.length === 0 ? read : [...read, ...unwritten];
		},

		/**
		 * One a boot cut off, at `cutAt`, without its shell's word is dated
		 * then and keeps no run time: it ran until some moment before the
		 * boot, not for as long as it seems, and a short one would teach its
		 * work as quick. A shell's word is dated by its own clock, the one
		 * its start was, so it keeps its run time whichever boot reads it.
		 */
		remember(job, now, cutAt) {
			if (!outcomes) return;
			const end = path(job.id, "end");
			const said = text(end).trim();
			const exit = /^\d+$/.test(said) ? Number(said) : undefined;
			let at = cutAt ?? now;
			let unsaid = false;
			try {
				at = Math.min(now, statSync(end).mtimeMs);
			} catch {
				// Unsaid: it ended when it was seen to, or with the boot that cut
				// it off.
				unsaid = true;
			}
			const moved =
				job.walk === "main-fetch" &&
				movedMain(
					text(path(job.id, "main-before")),
					text(path(job.id, "main-after")),
				);
			const measured = outcomeOf(job, at, exit, moved);
			const { ranS: _unknown, ...unmeasured } = measured;
			const outcome = cutAt !== undefined && unsaid ? unmeasured : measured;
			const file = outcomes;
			adding.set(outcome.id, outcome);
			const written: Promise<void> = lastWrite
				.then(() => appendOutcome(file, outcome))
				.then(
					() => halveOutcomes(file),
					() => undefined,
				)
				// An outcome that can't be kept never holds up the queue.
				.catch(() => undefined)
				.finally(() => {
					adding.delete(outcome.id);
					writing.delete(written);
				});
			lastWrite = written;
			writing.add(written);
		},

		async written() {
			await Promise.all([...writing]);
		},
	};
}

function text(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}
