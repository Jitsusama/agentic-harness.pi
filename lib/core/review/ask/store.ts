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

import { randomUUID } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileReads } from "../../../internal/files/file-reads.ts";
import { withFileLock } from "../../internal/file-lock.ts";
import type { ChangeRef } from "../change.ts";
import { changeFileName } from "../keys.ts";
import type { AskRound, AskRun } from "./run.ts";

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
	/**
	 * The newest finished council or stack round, held against any
	 * change in `repo`, whose reviewers read one of `commits`.
	 *
	 * Asked across changes because a change is reviewed before it has a
	 * number: a council on a local range is held under that range, and
	 * the change proposed from it is another key. A round that fell back
	 * to the caller's checkout never read the commit it names, so it
	 * doesn't count; nor does one still open or given up on. A ledger
	 * that won't read is passed over, which can only find less.
	 */
	witnessed(
		repo: string,
		commits: ReadonlySet<string>,
	): Promise<AskRun | undefined>;
}

/** A round still open, with what the ledger says of it. */
export interface OpenRound {
	readonly id: string;
	readonly startedAt: string;
	/** The session that started it, when it said. */
	readonly startedBy?: string;
	/** The change its ledger is kept under, once the ledger says. */
	readonly change?: ChangeRef;
}

/** Which rounds are open, and what could not be asked. */
export interface OpenRuns {
	readonly open: ReadonlySet<string>;
	/** The same rounds, each with what the ledger says of it. */
	readonly rounds: readonly OpenRound[];
	/**
	 * What exists and would not read, said the way a person can act on
	 * it: a full path, since a caller that declines over this has to
	 * tell somebody which file to go and deal with, and a bare name is
	 * not enough to find one under a state directory nobody memorized.
	 *
	 * Non-empty means the open set is incomplete and there is no way
	 * to tell which rounds are missing from it, so a caller deciding
	 * what to delete has to decline rather than read it as "none".
	 */
	readonly unreadable: readonly string[];
}

/**
 * What one change's file holds. The change itself is written beside
 * its rounds, so a sweep that finds a round nobody collected can name
 * the change, and collect it, without a session that knows it.
 */
interface Ledger {
	change?: ChangeRef;
	runs: AskRun[];
}

/** Runs on disk, one file per change. */
export function createRunStore(root: string): RunStore {
	async function read(change: ChangeRef): Promise<Ledger> {
		const bounded = await readAt(change, fileFor(change));
		if (bounded !== undefined) return bounded;
		// A ledger whose plain name fit a file but not with the pending
		// suffix's worst case was written, by a process with a shorter pid,
		// under that plain name. Its rounds are read from there, and the
		// next write carries them over to the bounded name.
		const plain = changeFileName(change);
		if (plain === fileFor(change)) return { runs: [] };
		return (await readAt(change, plain)) ?? { runs: [] };
	}

	/** The ledger in `file`, or undefined when there is no such file. */
	async function readAt(
		change: ChangeRef,
		file: string,
	): Promise<Ledger | undefined> {
		let raw: string;
		const path = join(root, file);
		try {
			raw = await readFile(path, "utf8");
		} catch (error) {
			// No file. This change has no rounds behind it, which is an
			// answer rather than a failure: most changes have never been
			// reviewed.
			//
			// Only ENOENT, though. Every other errno says the history is
			// there and could not be reached, and answering "no rounds" to
			// those is worse here than in the sweep: the next write lays a
			// one-round ledger over whatever was behind it. The reasoning
			// twenty lines down, about a file that will not parse, applies
			// exactly as well to a file that will not open.
			if (!isMissing(error)) {
				throw new Error(
					`The rounds held against ${change.label} could not be read from ${path}: ${error instanceof Error ? error.message : String(error)}. Fix or move that file: answering "no rounds" for it would let the next round overwrite the history behind it.`,
				);
			}
			return undefined;
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
			`The rounds held against ${change.label} are at ${path} and could not be read as a ledger. Nothing was changed. Move that file aside to start a fresh one, keeping it if the rounds in it still matter.`,
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
		// one. Named per write, not per process: two writes in one
		// process sharing a name tore the file, the shorter write landing
		// over the start of the longer.
		const pending = `${path}.${process.pid}.${randomUUID()}.tmp`;
		const kept: Ledger = { change, runs: ledger.runs };
		await writeFile(pending, JSON.stringify(kept, null, 2), "utf8");
		await rename(pending, path);
	}

	/**
	 * Read, change and write one change's ledger as a single step. Every
	 * write is a whole ledger built from the one read before it, so two
	 * of these at once, from parallel tool calls or two sessions on one
	 * change, would each lay its version over the other's and drop a
	 * round without an error.
	 */
	async function mutate(
		change: ChangeRef,
		next: (ledger: Ledger) => Ledger,
	): Promise<void> {
		await mkdir(root, { recursive: true });
		await withFileLock(join(root, fileFor(change)), async () => {
			await write(change, next(await read(change)));
			await dropCarriedOver(change);
		});
	}

	/**
	 * Remove a ledger's plain-named copy once its rounds are written under
	 * the bounded name. Left behind, the sweeps that read every file would
	 * keep finding its rounds open after they were settled here.
	 */
	async function dropCarriedOver(change: ChangeRef): Promise<void> {
		const plain = changeFileName(change);
		if (plain === fileFor(change)) return;
		try {
			await unlink(join(root, plain));
		} catch (error) {
			if (!isMissing(error)) throw error;
			// Most ledgers never had a plain-named copy; nothing to remove.
		}
	}

	return {
		async record(change, run) {
			await mutate(change, (ledger) => ({ runs: [...ledger.runs, run] }));
		},

		async list(change) {
			return (await read(change)).runs;
		},

		async openRunIds() {
			const open = new Set<string>();
			const rounds: OpenRound[] = [];
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
				if (!isMissing(error)) {
					return {
						open,
						rounds,
						unreadable: [`${root} (the whole ledger)`],
					};
				}
				return { open, rounds, unreadable };
			}
			// Each file is read again only once it has changed, since a host
			// asks at every conversation's start. What it keeps of a file is
			// its open rounds, or nothing when it would not read as a ledger.
			const kept = fileReads<readonly OpenRound[] | undefined>(
				"review-open-rounds",
				root,
			);
			const listed = new Set<string>();
			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				const path = join(root, file);
				listed.add(path);
				const seen = await kept.stamp(path);
				const held = kept.held(path, seen);
				if (held !== undefined) {
					if (held.said === undefined) unreadable.push(path);
					for (const round of held.said ?? []) {
						open.add(round.id);
						rounds.push(round);
					}
					continue;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(await readFile(path, "utf8"));
				} catch (error) {
					// A file that has gone since the listing is not a file
					// that will not read. Another session settling a round
					// deletes nothing, but a person tidying up does, and
					// treating that as a torn ledger stops the sweep on this
					// machine for good over a file nobody has any more.
					//
					// Nothing covers this branch, and the same is true of the
					// matching one in the artifact sweep's stat. Both windows
					// are between a listing and a read inside one call, with
					// no seam to hold open from outside, and a case that raced
					// for one would be a case that fails sometimes. Two
					// attempts at a test for this deleted the file before the
					// listing, which exercises nothing and passes.
					if (isMissing(error)) continue;
					// Said, not skipped. Skipping used to be justified on the
					// grounds that the sweep errs towards deleting nothing it
					// was unsure about, and it does not: a run it is unsure
					// about is a run nothing protects, which is the ordinary
					// window. One torn file among twenty took protection off
					// that change's rounds with no error anywhere.
					kept.keep(path, seen, undefined);
					unreadable.push(path);
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
					kept.keep(path, seen, undefined);
					unreadable.push(path);
					continue;
				}
				const change =
					"change" in parsed && isChangeRef(parsed.change)
						? parsed.change
						: undefined;
				const found: OpenRound[] = [];
				for (const run of parsed.runs as AskRun[]) {
					if (run?.open === true && typeof run.id === "string") {
						open.add(run.id);
						found.push({
							id: run.id,
							startedAt: run.startedAt,
							...(typeof run.startedBy === "string"
								? { startedBy: run.startedBy }
								: {}),
							...(change ? { change } : {}),
						});
					}
				}
				kept.keep(path, seen, found);
				rounds.push(...found);
			}
			kept.keepOnly(listed);
			return { open, rounds, unreadable };
		},

		async witnessed(repo, commits) {
			let files: string[];
			try {
				files = await readdir(root);
			} catch {
				// No ledger, or none that can be read: no council is known.
				return undefined;
			}
			// Asked at every proposal, over every change ever reviewed here,
			// so each file is parsed again only once it has changed. What is
			// kept of one is its repo and the rounds that read something.
			const kept = fileReads<Witnessing | undefined>("review-witnesses", root);
			const listed = new Set<string>();
			let newest: AskRun | undefined;
			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				const path = join(root, file);
				listed.add(path);
				const seen = await kept.stamp(path);
				let held = kept.held(path, seen)?.said;
				if (held === undefined) {
					held = await witnessingIn(path);
					kept.keep(path, seen, held);
				}
				if (held === undefined || held.repo !== repo) continue;
				for (const run of held.rounds) {
					if (!readOneOf(run, commits)) continue;
					if (newest === undefined || run.startedAt > newest.startedAt) {
						newest = run;
					}
				}
			}
			kept.keepOnly(listed);
			return newest;
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
			await mutate(change, (ledger) => {
				const at = ledger.runs.findIndex((held) => held.id === run.id);
				return {
					runs:
						at === -1
							? [...ledger.runs, run]
							: ledger.runs.map((held, index) => (index === at ? run : held)),
				};
			});
		},
		async replace(change, run) {
			await mutate(change, (ledger) => {
				const at = ledger.runs.findIndex((held) => held.id === run.id);
				if (at === -1) {
					// Adding it silently would make a retry look like it
					// patched something when it invented a round instead.
					throw new Error(
						`No run "${run.id}" is held against this change, so there is nothing to replace. Record it first, or check the id.`,
					);
				}
				return {
					runs: ledger.runs.map((held, index) => (index === at ? run : held)),
				};
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

/** A ledger's repo, and its finished rounds whose reviewers read a commit. */
interface Witnessing {
	repo: string;
	rounds: AskRun[];
}

/** What a ledger file says was read, or nothing when it isn't a ledger. */
async function witnessingIn(path: string): Promise<Witnessing | undefined> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch {
		// Gone or torn: it can only hold a council not counted.
		return undefined;
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("change" in parsed) ||
		!isChangeRef(parsed.change) ||
		!("runs" in parsed) ||
		!Array.isArray(parsed.runs)
	) {
		return undefined;
	}
	const rounds: AskRun[] = parsed.runs.filter(readSomething);
	return { repo: parsed.change.repo.key, rounds };
}

/**
 * Whether `run` is a finished council or stack round, pinned to what
 * it read, that at least one reviewer answered. A round that fell back
 * to the caller's checkout read nothing it names.
 */
function readSomething(run: unknown): run is AskRun {
	if (typeof run !== "object" || run === null) return false;
	const round = "round" in run ? run.round : undefined;
	return (
		(round === "council" || round === "stack") &&
		!("open" in run && run.open === true) &&
		!("closed" in run && run.closed === true) &&
		!("unpinned" in run && run.unpinned !== undefined) &&
		"startedAt" in run &&
		typeof run.startedAt === "string" &&
		"outcomes" in run &&
		Array.isArray(run.outcomes) &&
		run.outcomes.some(
			(outcome: unknown) =>
				typeof outcome === "object" &&
				outcome !== null &&
				!("failure" in outcome && outcome.failure !== undefined),
		)
	);
}

/** Whether `run`'s reviewers read one of `commits`. */
function readOneOf(run: AskRun, commits: ReadonlySet<string>): boolean {
	const read = [
		...(typeof run.witness === "string" ? [run.witness] : []),
		...(Array.isArray(run.witnesses) ? run.witnesses : []),
	];
	return read.some((sha) => commits.has(sha));
}

/**
 * The bytes a pending write's suffix adds to a ledger's name: a dot,
 * a pid of up to seven digits, a dot, a 36-character UUID and ".tmp".
 */
const PENDING_SUFFIX_BYTES = 1 + 7 + 1 + 36 + ".tmp".length;

/** Whether a ledger's `change` is a change, as a later write left it. */
function isChangeRef(value: unknown): value is ChangeRef {
	if (typeof value !== "object" || value === null) return false;
	const repo = "repo" in value ? value.repo : undefined;
	return (
		"provider" in value &&
		typeof value.provider === "string" &&
		"id" in value &&
		typeof value.id === "string" &&
		"label" in value &&
		typeof value.label === "string" &&
		typeof repo === "object" &&
		repo !== null &&
		"key" in repo &&
		typeof repo.key === "string"
	);
}

/**
 * The file a change's rounds live in.
 *
 * Slugged because the key names a file: a change id is somebody
 * else's string and may hold a separator. Short enough that the
 * pending copy written beside it still has a name the filesystem
 * takes.
 */
function fileFor(change: ChangeRef): string {
	return changeFileName(change, PENDING_SUFFIX_BYTES);
}
