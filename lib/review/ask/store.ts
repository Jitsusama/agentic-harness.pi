/**
 * Rounds kept per change, outliving the session that ran them.
 *
 * A judge consolidates a council, a critique pushes back on a judge,
 * and a retry substitutes into a round that already happened. All
 * three need to find a round somebody else ran, possibly in a
 * different session, so rounds live on disk beside the findings
 * rather than in session state.
 *
 * Every round is kept, not just the last. A judge that consolidated a
 * council needs that council still to be there, or nothing can say
 * what it consolidated.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChangeRef } from "../change.js";
import { changeKey } from "../keys.js";
import type { AskRound, AskRun } from "./run.js";

/** Rounds held against a change. */
export interface RunStore {
	/** Add a round, after the ones already held. */
	record(change: ChangeRef, run: AskRun): Promise<void>;
	/** Every round on a change, in the order they ran. */
	list(change: ChangeRef): Promise<AskRun[]>;
	/** The most recent finished round of one kind, if there was one. */
	latest(change: ChangeRef, round: AskRound): Promise<AskRun | undefined>;
	/** One round by its id. */
	byId(change: ChangeRef, runId: string): Promise<AskRun | undefined>;
	/** Swap a round for a new version of itself, in place. */
	replace(change: ChangeRef, run: AskRun): Promise<void>;
	/**
	 * Hold this version of a round, whether or not one is held.
	 *
	 * A round is written down twice: once when it opens, before it has
	 * asked anybody, and once when it settles. Both are this call,
	 * rather than a record and then a replace, so neither site has to
	 * know whether the other one happened. It matters because the
	 * opening write is best-effort: bookkeeping must not cost a round,
	 * and if settling were a replace, an opening write that failed
	 * would turn the end of a long council into an exception and throw
	 * away everything it found.
	 *
	 * Distinct from `replace`, which refuses a round it has never seen
	 * on purpose: a retry patching a round that does not exist has
	 * invented one, and should say so rather than quietly adding it.
	 */
	keep(change: ChangeRef, run: AskRun): Promise<void>;
}

/** What one change's file holds. */
interface Ledger {
	runs: AskRun[];
}

/** Runs on disk, one file per change. */
export function createRunStore(root: string): RunStore {
	async function read(change: ChangeRef): Promise<Ledger> {
		let raw: string;
		try {
			raw = await readFile(join(root, fileFor(change)), "utf8");
		} catch {
			// No file. This change has no rounds behind it, which is an
			// answer rather than a failure: most changes have never been
			// reviewed.
			return { runs: [] };
		}
		// A file that will not parse is a different thing entirely, and
		// answering "no rounds" for it is how a history disappears
		// quietly: the caller is told the change is fresh, and the next
		// write lays a one-round ledger over whatever was there. Said
		// out loud instead, so a torn file is a problem somebody can
		// see rather than a change that looks new.
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			// Falls through to the sentence below, which says where the
			// file is and what to do. A parser's own message names a
			// character offset in a file the reader has not been told
			// about.
		}
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"runs" in parsed &&
			Array.isArray(parsed.runs)
		) {
			return { runs: parsed.runs as AskRun[] };
		}
		throw new Error(
			`The rounds held against ${change.label} are at ${join(root, fileFor(change))} and could not be read as a ledger. Nothing was changed. Move that file aside to start a fresh one, keeping it if the rounds in it still matter.`,
		);
	}

	async function write(change: ChangeRef, ledger: Ledger): Promise<void> {
		await mkdir(root, { recursive: true });
		const path = join(root, fileFor(change));
		// Written beside and renamed over, because a plain write
		// truncates in place and a process killed midway leaves half a
		// document. This change writes at the start of an operation
		// whose whole premise is that the session may not survive it,
		// so the window stopped being theoretical. A rename within one
		// directory is atomic: a reader sees the old ledger or the new
		// one.
		const pending = `${path}.${process.pid}.tmp`;
		await writeFile(pending, JSON.stringify(ledger, null, 2), "utf8");
		await rename(pending, path);
	}

	return {
		async record(change, run) {
			const ledger = await read(change);
			await write(change, { runs: [...ledger.runs, run] });
		},

		async list(change) {
			return (await read(change)).runs;
		},

		async latest(change, round) {
			// Finished rounds only. A round is now on the ledger from the
			// moment it opens, so the newest entry is routinely one that
			// has answered nothing: a judge asked while a council was
			// still running, or after one was interrupted, would have
			// consolidated its empty outcomes and reported that the
			// council found nothing.
			const held = (await read(change)).runs.filter(
				(r) => r.round === round && r.open !== true,
			);
			return held.at(-1);
		},

		async byId(change, runId) {
			return (await read(change)).runs.find((r) => r.id === runId);
		},

		async keep(change, run) {
			const ledger = await read(change);
			const at = ledger.runs.findIndex((held) => held.id === run.id);
			await write(change, {
				runs:
					at === -1
						? [...ledger.runs, run]
						: ledger.runs.map((held, index) => (index === at ? run : held)),
			});
		},
		async replace(change, run) {
			const ledger = await read(change);
			const at = ledger.runs.findIndex((held) => held.id === run.id);
			if (at === -1) {
				// Adding it silently would make a retry look like it
				// patched something when it invented a round instead.
				throw new Error(
					`No run "${run.id}" is held against this change, so there is nothing to replace. Record it first, or check the id.`,
				);
			}
			await write(change, {
				runs: ledger.runs.map((held, index) => (index === at ? run : held)),
			});
		},
	};
}

/**
 * The file a change's rounds live in.
 *
 * Slugged because the key names a file: a change id is somebody
 * else's string and may hold a separator.
 */
function fileFor(change: ChangeRef): string {
	const safe = changeKey(change)
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.replace(/^\.+/, "_");
	return `${safe}.json`;
}
