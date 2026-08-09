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

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
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
	/**
	 * Every round still open, across every change.
	 *
	 * The one question here that is not about a change, and it exists
	 * for the retention sweep. A detached round finishes on disk and
	 * stays open on the ledger until somebody collects it, so a sweep
	 * that judges a run by whether it is terminal will happily delete
	 * the answers a round is still waiting to be asked for. Before
	 * rounds outlived their sessions the two could not disagree.
	 *
	 * What could not be read is answered beside what could, rather
	 * than thrown or quietly skipped. Skipping was wrong in the one
	 * direction that costs something: a torn file drops protection
	 * from every round it held, silently and only for that change,
	 * which is a sweep deleting paid-for reviews and reporting a clean
	 * run. Throwing would be no better, since the answer for every
	 * other change is perfectly good and a sweep that ran would
	 * reclaim real disk. The caller decides, and it has what it needs
	 * to decide with.
	 */
	openRunIds(): Promise<OpenRuns>;
}

/** Which rounds are open, and which files could not be asked. */
export interface OpenRuns {
	readonly open: ReadonlySet<string>;
	/**
	 * Ledger files that exist and would not read, by name.
	 *
	 * Non-empty means the open set is incomplete and there is no way
	 * to tell which rounds are missing from it.
	 */
	readonly unreadable: readonly string[];
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

		async openRunIds() {
			const open = new Set<string>();
			const unreadable: string[] = [];
			let files: string[];
			try {
				files = await readdir(root);
			} catch (error) {
				// No ledger directory at all, so no rounds are open. The
				// caller is a sweep, and answering "none" is the honest
				// reading of an empty history.
				//
				// Only for that reading, though. Every other errno says the
				// history is there and cannot be seen, and answering "none"
				// to those tells a sweep every round is collectable rubbish.
				// The catch used to be untyped, so a permissions problem on
				// this directory read as an empty history.
				if (!isMissing(error)) return { open, unreadable: [root] };
				return { open, unreadable };
			}
			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(await readFile(join(root, file), "utf8"));
				} catch {
					// Said, not skipped. Skipping used to be justified on the
					// grounds that the sweep errs towards deleting nothing it
					// was unsure about, and it does not: a run it is unsure
					// about is a run nothing protects, which is the ordinary
					// window. One torn file among twenty took protection off
					// that change's rounds with no error anywhere.
					unreadable.push(file);
					continue;
				}
				if (
					typeof parsed !== "object" ||
					parsed === null ||
					!("runs" in parsed) ||
					!Array.isArray(parsed.runs)
				) {
					// A file that parses into the wrong shape is no more
					// readable than one that does not parse at all.
					unreadable.push(file);
					continue;
				}
				for (const run of parsed.runs as AskRun[]) {
					if (run?.open === true && typeof run.id === "string") {
						open.add(run.id);
					}
				}
			}
			return { open, unreadable };
		},

		async latest(change, round) {
			// Finished rounds only. A round is now on the ledger from the
			// moment it opens, so the newest entry is routinely one that
			// has answered nothing: a judge asked while a council was
			// still running, or after one was interrupted, would have
			// consolidated its empty outcomes and reported that the
			// council found nothing.
			const held = (await read(change)).runs.filter(
				// Nor one a person gave up on, which is neither open nor
				// finished. It has no outcomes, so handing it back here
				// would have a judge consolidate nothing and report that
				// the council found nothing, with the real council one
				// entry behind and unreachable.
				(r) => r.round === round && r.open !== true && r.closed !== true,
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
 * Whether a filesystem error means the thing is simply not there.
 *
 * The distinction matters wherever absence is an answer, because
 * every other errno means the thing exists and could not be reached,
 * and reporting that as absence is how a sweep concludes a full
 * history is an empty one.
 */
function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
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
