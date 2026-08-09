/**
 * A durable record of the fleets this machine has dispatched.
 *
 * A fleet's answers exist in two places: the tool result handed back
 * to the session that asked for them, and the transcripts on disk.
 * When a session dies mid-fleet the first never happens, so the
 * transcripts are the only copy, and until this existed nothing said
 * so: the retention sweep saw a run directory of the ordinary age and
 * took it. That is the same reasoning that put a ledger under the
 * review rounds, arrived at again one layer down, and the shape here
 * is deliberately the shape that argument produced there.
 *
 * One file per fleet, rather than one file holding all of them. The
 * review ledger groups rounds by the change they are about because
 * the question asked of it is always about a change; nothing groups
 * fleets, and two sessions dispatching at once is ordinary, so a
 * read-modify-write over a shared file would lose one of them.
 */
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { isDirectory, isNotFound, safeSegment } from "./errno.js";

/** A fleet that was dispatched, as the ledger holds it. */
export interface FleetRun {
	/** The run id, as the caller spelled it. */
	readonly id: string;
	readonly startedAt: string;
	/** The jobs asked for, by id, in the order they were given. */
	readonly jobs: readonly string[];
	/**
	 * Dispatched, and not settled since.
	 *
	 * Present only while that is true, rather than inferred from a
	 * missing settled time, so that absence never means "still
	 * running" for a record written by something that did not know
	 * about this field.
	 */
	readonly open?: true;
	readonly settledAt?: string;
}

/** Which fleets nothing has read yet, and what could not be asked. */
export interface OpenFleets {
	/** Fleet ids, spelled as the caller spelled them. */
	readonly open: ReadonlySet<string>;
	/**
	 * Ledger files that exist and would not read, by full path.
	 *
	 * Non-empty means the open set is incomplete with no way to say
	 * which fleets are missing from it, so a caller deciding what to
	 * delete has to decline rather than read it as "nothing to keep".
	 * A full path because a caller that declines has to be able to
	 * tell somebody which file to go and deal with.
	 */
	readonly unreadable: readonly string[];
}

/** Everything the ledger holds, and everything it could not ask. */
export interface HeldFleets {
	readonly runs: readonly FleetRun[];
	/** As {@link OpenFleets.unreadable}, and read the same way. */
	readonly unreadable: readonly string[];
}

/** The durable fleet record. */
export interface FleetLedger {
	/** Write a fleet down, before it is dispatched. */
	open(run: FleetRun): Promise<void>;
	/** Mark a fleet as one somebody has been handed. */
	settle(id: string): Promise<void>;
	/**
	 * Every fleet held, beside what would not read.
	 *
	 * The unreadable half is not optional and not separable. A listing
	 * answering a bare array would answer "no fleets" for a ledger that
	 * will not open, which is the misreading the rest of this module
	 * exists to prevent, and it would be the one call on the public
	 * surface that makes it.
	 */
	held(): Promise<HeldFleets>;
	/** Which fleets are still nobody's, for the retention sweep. */
	openFleets(): Promise<OpenFleets>;
	/**
	 * Forget settled fleets whose transcripts are gone anyway.
	 *
	 * The ledger needs a window of its own, or it becomes the unbounded
	 * thing it was built to bound: one small file per fleet ever
	 * dispatched, all of them read at every session start. Settled
	 * only, and older than the window the transcripts themselves get,
	 * so a record is dropped after the thing it points at has gone.
	 * Open fleets are never dropped, for the reason nothing else may
	 * take them either.
	 */
	forgetSettledBefore(cutoff: Date): Promise<number>;
}

/** Fleets on disk, one file each. */
export function createFleetLedger(root: string): FleetLedger {
	// The same spelling the transcripts use. Two sanitizers meant two
	// ways for distinct ids to collide, differently, so a pair could
	// share one ledger record while owning separate run directories,
	// and settling either released the protection on both.
	const pathFor = (id: string): string => join(root, `${safeSegment(id)}.json`);

	async function put(run: FleetRun): Promise<void> {
		await mkdir(root, { recursive: true });
		const path = pathFor(run.id);
		// Written beside and renamed over. A plain write truncates in
		// place, and this writes at the start of an operation whose
		// premise is that the session may not survive it, so a reader
		// finding half a document is not a theoretical window.
		//
		// The staging name carries a counter as well as the pid, because
		// a pid does not tell two writes in one process apart and the
		// open and the settle of one fleet are exactly that pair.
		staging += 1;
		const pending = `${path}.${process.pid}.${staging}.tmp`;
		await writeFile(pending, JSON.stringify(run, null, 2), "utf8");
		await rename(pending, path);
	}

	async function readAll(): Promise<{
		runs: FleetRun[];
		unreadable: string[];
	}> {
		let files: string[];
		try {
			files = await readdir(root);
		} catch (error) {
			// No directory at all is the ordinary case, since the great
			// majority of sessions never dispatch a fleet. Reading that
			// as an empty ledger is right; reading a directory that is
			// there and will not open as one is not, so it is reported.
			if (isNotFound(error)) return { runs: [], unreadable: [] };
			return { runs: [], unreadable: [root] };
		}
		const runs: FleetRun[] = [];
		const unreadable: string[] = [];
		for (const file of files) {
			// Ledger files only. This is a state directory and will
			// collect temporary files, editor droppings and whatever
			// else, none of which is a fleet that would not read.
			if (!file.endsWith(".json")) continue;
			const path = join(root, file);
			let parsed: unknown;
			try {
				parsed = JSON.parse(await readFile(path, "utf8"));
			} catch (error) {
				// Gone since the listing is not a file that will not read,
				// and neither is a directory somebody named with a .json
				// suffix. Everything else is a fleet this cannot account
				// for, and the caller has to know that before it deletes
				// anything.
				if (isNotFound(error) || isDirectory(error)) continue;
				unreadable.push(path);
				continue;
			}
			if (isFleetRun(parsed)) runs.push(parsed);
			else unreadable.push(path);
		}
		return { runs, unreadable };
	}

	return {
		async open(run) {
			// The settled time is dropped rather than carried, because a
			// caller may hand back a record it read from here and an id may
			// be dispatched twice. A record that is open and settled at
			// once is a contradiction, and the half of it that is a date is
			// the half a window reads.
			const { settledAt: _before, ...rest } = run;
			await put({ ...rest, open: true });
		},

		async settle(id) {
			const path = pathFor(id);
			let parsed: unknown;
			try {
				parsed = JSON.parse(await readFile(path, "utf8"));
			} catch (error) {
				// Nothing to settle. The open write is best effort, because
				// bookkeeping must not cost a fleet, so this is reachable
				// whenever that write failed. Writing a settled record here
				// instead would put a fleet on the ledger that nothing
				// protected while it ran, which reads afterwards as evidence
				// that it was safe.
				if (isNotFound(error)) return;
				// A record this cannot read is one it must not overwrite, and
				// it is the same file the sweep declines over: one file, one
				// answer. Named, because a parser's own complaint gives a
				// character offset in a file nobody has been told about.
				throw new Error(
					`The fleet held at ${path} could not be read, so ${id} was not settled: ${error instanceof Error ? error.message : String(error)}. Fix that file or move it aside.`,
				);
			}
			if (!isFleetRun(parsed)) {
				throw new Error(
					`The file at ${path} is not a fleet record, so ${id} was not settled. Move it aside: nothing here will overwrite it, and the sweep declines while it is there.`,
				);
			}
			const { open: _wasOpen, ...rest } = parsed;
			await put({ ...rest, settledAt: new Date().toISOString() });
		},

		async held() {
			return await readAll();
		},

		async openFleets() {
			const { runs, unreadable } = await readAll();
			return {
				open: new Set(
					runs.filter((run) => run.open === true).map((run) => run.id),
				),
				unreadable,
			};
		},

		async forgetSettledBefore(cutoff) {
			const { runs } = await readAll();
			let forgotten = 0;
			for (const run of runs) {
				if (run.open === true || run.settledAt === undefined) continue;
				if (Date.parse(run.settledAt) >= cutoff.getTime()) continue;
				try {
					await rm(pathFor(run.id));
					forgotten += 1;
				} catch {
					// One small file left behind costs a listing entry and
					// nothing else, so it is not worth failing a sweep the rest
					// of which reclaims megabytes. Gone already is the answer
					// this wanted anyway.
				}
			}
			return forgotten;
		},
	};
}

/**
 * A counter making one process's staging names distinct.
 *
 * Module scope rather than per ledger, since two ledgers over one
 * directory is a thing a caller may do and the pid does not tell
 * those apart either.
 */
let staging = 0;

/** Whether this is a record this ledger wrote. */
function isFleetRun(value: unknown): value is FleetRun {
	if (typeof value !== "object" || value === null) return false;
	const run = value as Record<string, unknown>;
	return (
		typeof run.id === "string" &&
		typeof run.startedAt === "string" &&
		Array.isArray(run.jobs)
	);
}
