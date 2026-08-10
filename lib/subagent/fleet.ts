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
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
	askedOnce,
	type Owner,
	ownerNow,
	ownerStanding,
	type ProcessFacts,
} from "../process/index.js";
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
	/**
	 * The session that dispatched this fleet and is waiting for it.
	 *
	 * Optional because a record written before this existed cannot
	 * have one, and absent has to keep meaning not told rather than
	 * nobody: reading it as nobody would cancel every fleet on an
	 * older ledger at the next session start.
	 */
	/**
	 * A pid and when that process started, because a pid identifies
	 * nothing on its own: the number comes round again, and a stranger
	 * wearing it reads as the session still being there, which is the
	 * reading that leaves an orphan running.
	 */
	readonly owner?: Owner;
}

/**
 * Which of these fleets nobody is waiting for any more.
 *
 * There is no detached dispatch: nothing starts a fleet meaning to
 * come back for it later, the way a review round can be started and
 * collected. So a fleet whose session has gone is running for nobody,
 * holding models open against their own backstops for hours, and the
 * answers will have nowhere to go when they arrive.
 *
 * Only open records can be abandoned, and that is decided here rather
 * than asked of the caller. A settled fleet was handed to somebody
 * whatever became of them afterwards, so a dead owner says nothing
 * about it, and a precondition living at one call site is one the
 * next caller has no way to know about.
 *
 * Identity decides, both ways, the same discipline the supervisor
 * lease uses: a live pid that started when the record says is the
 * session still waiting, and a live pid that started at some other
 * time is a stranger wearing a recycled number. Everything unsure
 * resolves to leaving the fleet alone, because the cost of that is an
 * orphan running to a backstop it would have reached anyway, and the
 * cost of being wrong the other way is cancelling work somebody is
 * sitting in front of.
 */
export async function abandonedFleets(
	runs: readonly FleetRun[],
	facts: ProcessFacts,
): Promise<readonly FleetRun[]> {
	const abandoned: FleetRun[] = [];
	// Asked once per session rather than once per fleet. Every fleet
	// one session dispatched names the same pid, the answer cannot
	// change while this runs, and the population being walked is the
	// one designed to grow: a hundred held fleets from one dead session
	// is a hundred subprocesses at every session start.
	//
	// What the machine said, not what was concluded from it. Caching
	// the verdict here was a regression this had already got right:
	// two fleets can name one pid with different start times, one
	// stale and one live, and a verdict held by pid alone lets the
	// stale one decide for the live one.
	const once = askedOnce(facts);
	for (const run of runs) {
		if (run.open !== true) continue;
		const owner = run.owner;
		if (owner === undefined) continue;
		// Only a decisive "gone" counts. Undecidable means the machine
		// would not say when the pid started, so liveness is the only
		// evidence there is and it says somebody is there: it fails open,
		// which is why it is the fallback rather than the rule.
		if ((await ownerStanding(owner, once)) === "gone") abandoned.push(run);
	}
	return abandoned;
}

/**
 * This process, as something a later session can check.
 *
 * The counterpart of {@link abandonedFleets} and here beside it, so
 * the two spellings of an owner cannot drift: one writes the pair, the
 * other believes it.
 *
 * Nothing at all when the machine will not report a birthday, rather
 * than a pid on its own. A bare pid is worse than no owner, because
 * absent reads as "still waiting" and a pid the machine cannot
 * identify reads as whatever wears that number next.
 */
export async function whoIsWaiting(
	facts: ProcessFacts,
	pid: number = process.pid,
): Promise<FleetRun["owner"]> {
	// The shared one. Kept as a name of its own because the caller
	// here is asking a question in this module's vocabulary, and
	// because the two spellings of an owner cannot be allowed to drift
	// whatever they are called.
	return await ownerNow(facts, pid);
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
	 * Every fleet on the ledger, beside what would not read.
	 *
	 * The unreadable half is not optional and not separable. A listing
	 * answering a bare array would answer "no fleets" for a ledger that
	 * will not open, which is the misreading the rest of this module
	 * exists to prevent, and it would be the one call on the public
	 * surface that makes it.
	 *
	 * Not called `held`, though it lists what is held, because `held`
	 * is already the count of runs a sweep kept and the two are
	 * different populations: this one includes the settled.
	 */
	everyFleet(): Promise<HeldFleets>;
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
		//
		// A timestamp as well as the counter, because the counter starts
		// again at zero every time this module is loaded and a reload is
		// an ordinary event in a long session.
		staging += 1;
		const pending = `${path}.${process.pid}.${Date.now()}.${staging}${STAGING_SUFFIX}`;
		await writeFile(pending, JSON.stringify(run, null, 2), "utf8");
		await rename(pending, path);
	}

	async function readAll(): Promise<{
		runs: { run: FleetRun; path: string }[];
		unreadable: string[];
		staged: string[];
	}> {
		let files: string[];
		try {
			files = await readdir(root);
		} catch (error) {
			// No directory at all is the ordinary case, since the great
			// majority of sessions never dispatch a fleet. Reading that
			// as an empty ledger is right; reading a directory that is
			// there and will not open as one is not, so it is reported.
			if (isNotFound(error)) return { runs: [], unreadable: [], staged: [] };
			return { runs: [], unreadable: [root], staged: [] };
		}
		const runs: { run: FleetRun; path: string }[] = [];
		const unreadable: string[] = [];
		const staged: string[] = [];
		for (const file of files) {
			// A write that was interrupted between the write and the
			// rename, which is the failure the pair exists for, so this
			// directory would otherwise accumulate them in the one place
			// whose whole job is to stay small.
			if (file.endsWith(STAGING_SUFFIX)) {
				staged.push(join(root, file));
				continue;
			}
			// Beyond this point, a name is either a record or none of
			// this module's business.
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
			if (isFleetRun(parsed)) runs.push({ run: parsed, path });
			else unreadable.push(path);
		}
		return { runs, unreadable, staged };
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
			// Derived, and the one place that is right: this is where a
			// record is looked up by the id its writer used, so the
			// derivation is the lookup. `forgetSettledBefore` keeps the
			// path it read instead, because it starts from a listing and
			// a record somebody put there by hand names a different file
			// than its own id derives.
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

		async everyFleet() {
			const { runs, unreadable } = await readAll();
			return { runs: runs.map((held) => held.run), unreadable };
		},

		async openFleets() {
			const { runs, unreadable } = await readAll();
			return {
				open: new Set(
					runs
						.filter((held) => held.run.open === true)
						.map((held) => held.run.id),
				),
				unreadable,
			};
		},

		async forgetSettledBefore(cutoff) {
			const { runs, staged } = await readAll();
			let forgotten = 0;
			// The file this record was read out of, not a path derived
			// again from the id inside it. Those are the same path for
			// every record this wrote, and are not for one somebody put
			// there by hand, where deriving deletes a different fleet's
			// record and leaves this one to be found again next time.
			for (const { run, path } of runs) {
				if (run.open === true || run.settledAt === undefined) continue;
				const settled = Date.parse(run.settledAt);
				// A date that will not parse compares false against
				// everything, so asking whether it is recent enough to keep
				// answers no and the record goes whatever the cutoff. Kept
				// instead: one small file is cheaper than a fleet forgotten
				// on the strength of a field nothing could read.
				if (Number.isNaN(settled) || settled >= cutoff.getTime()) continue;
				if (await forget(path)) forgotten += 1;
			}
			// Interrupted writes, reclaimed on the same pass. They are
			// unreachable by anything and they accumulate in the one
			// directory whose whole purpose is to stay small.
			//
			// Only the ones old enough to be nobody's. A staging file is
			// live for the microseconds between a write and its rename, so
			// deleting every one a listing finds means a session start can
			// delete another process's ledger write mid-flight, and that
			// write is a fleet losing its protection at the moment it was
			// being granted. An hour is far beyond any write and far
			// inside any window that matters.
			const abandoned = Date.now() - STAGING_IS_NOBODYS_AFTER_MS;
			for (const path of staged) {
				const wrote = await writtenAt(path);
				if (wrote !== undefined && wrote < abandoned) await forget(path);
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

/** What an interrupted write leaves behind, so a sweep can find it. */
const STAGING_SUFFIX = ".staging";

/**
 * How long a staging file must sit before it counts as abandoned.
 *
 * The gap it covers is a write and a rename, which is microseconds.
 * The window is an hour because the cost of waiting is one small
 * file and the cost of being wrong is deleting a live write.
 */
const STAGING_IS_NOBODYS_AFTER_MS = 60 * 60 * 1000;

/** When a path was last written, or nothing if it has gone. */
async function writtenAt(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		// Gone, or unreachable. Either way this is not a file to delete
		// on the strength of an age nothing could read.
		return undefined;
	}
}

/** Remove a file, reporting whether it went. */
async function forget(path: string): Promise<boolean> {
	try {
		await rm(path);
		return true;
	} catch {
		// One small file left behind costs a listing entry and nothing
		// else, so it is not worth failing a sweep the rest of which
		// reclaims megabytes. Gone already is the answer this wanted.
		return false;
	}
}

/** Whether this is a record this ledger wrote. */
function isFleetRun(value: unknown): value is FleetRun {
	if (typeof value !== "object" || value === null) return false;
	const run = value as Record<string, unknown>;
	return (
		typeof run.id === "string" &&
		typeof run.startedAt === "string" &&
		Array.isArray(run.jobs) &&
		ownerIsWellFormed(run.owner)
	);
}

/**
 * Whether an owner is one, or is honestly absent.
 *
 * Deliberately not the shared `isOwner`, which asks whether something
 * identifies a process and answers no for absent. This asks whether a
 * record may be believed, and absent is a perfectly believable record.
 * They were briefly the same name for those two opposite answers.
 *
 * Checked rather than trusted because of which way a half-written one
 * falls. An owner with a pid and no birthday cannot be identified, so
 * it reads as a session that has gone, and this is the field that
 * decides whether a fleet is offered up for deletion. A record that
 * cannot be believed is better refused whole: unreadable stops the
 * sweep, and being offered a live fleet to delete does not.
 */
function ownerIsWellFormed(value: unknown): boolean {
	// Null as well as undefined, since null is what JSON says when
	// something writes the field out empty, and refusing the record
	// over a spelling of "nobody" wedges the sweep for no reason.
	if (value === undefined || value === null) return true;
	if (typeof value !== "object") return false;
	const owner = value as Record<string, unknown>;
	return (
		typeof owner.pid === "number" &&
		// Positive, like the two sibling gates that decide whether to
		// signal something. A zero or negative pid names a process
		// group or nothing at all, and it must not reach a comparison
		// that concludes a session is still alive.
		owner.pid > 0 &&
		typeof owner.startedAt === "number"
	);
}
