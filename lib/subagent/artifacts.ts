import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ReviewerRunArtifacts } from "./subagent.js";

/**
 * Terminal lifecycle states persisted by supervised reviewer runs.
 *
 * `errored` is the one that is not a lifecycle event: the child exited
 * cleanly but its final turn died on a provider or transport failure,
 * so the supervisor downgrades `complete` to this. It was missing from
 * this union while `supervisor.mjs` was already writing it, which made
 * every read of the field a quiet lie and any exhaustive switch over
 * it wrong.
 */
export type ReviewerTerminalState =
	| "complete"
	| "errored"
	| "failed"
	| "cancelled"
	| "timeout"
	| "idle-timeout"
	/**
	 * Stopped inside its wall clock, on purpose, so the rest of the
	 * budget could be spent asking it for what it had.
	 *
	 * The only state here that does not describe something going
	 * wrong. The run was healthy and was interrupted anyway.
	 */
	| "soft-deadline"
	| "parent-exit"
	/**
	 * Its supervisor went away, and nothing wrote it a result.
	 *
	 * The only state here no supervisor ever writes, because the
	 * supervisor is the thing that is missing. It is reconstructed by
	 * whoever finds the reviewer's journal on disk with no result
	 * beside it, and it exists so that reviewer cannot be recorded as
	 * one that read the change and answered: without a state, nothing
	 * downstream has any way to tell the two apart.
	 */
	| "supervisor-lost";

/** Paths owned by one reviewer job. */
export interface ReviewerRunPaths extends ReviewerRunArtifacts {
	/**
	 * Where this reviewer records findings as it forms them.
	 *
	 * Optional on {@link ReviewerRunArtifacts}, because a runner that
	 * keeps no artifacts has nowhere to put one, and required here,
	 * because these paths are derived from a directory that exists.
	 * Left optional, every caller writes a guard against a case that
	 * cannot arise, and one of them will eventually treat it as the
	 * reviewer having no journal rather than as impossible.
	 */
	readonly journalPath: string;
	readonly requestPath: string;
	readonly leasePath: string;
	readonly cancelPath: string;
	/** Where the reviewer's prompt is kept, when one was written. */
	readonly promptPath: string;
	/** Always set for a supervised run; the session lives here. */
	readonly sessionDir: string;
}

/** Paths owned by a whole reviewer run. */
export interface ReviewerRunRootPaths {
	readonly runDir: string;
	readonly runPath: string;
	readonly cancelPath: string;
	readonly reviewersDir: string;
}

/** Result of appending to a capped artifact. */
export interface AppendOutcome {
	readonly written: boolean;
	readonly bytesAfter: number;
	readonly limitExceeded: boolean;
}

/** Retention policy for reviewer run directories. */
export interface RetentionPolicy {
	readonly maxAgeMs: number;
	/**
	 * How many finished, unprotected runs to keep.
	 *
	 * Not a bound on the directory, and it never quite was: a run is
	 * ranked among the runs this could take, so the ones it cannot
	 * take do not spend it. Ranking among every directory instead read
	 * as a bound and behaved like a hazard, since the runs it cannot
	 * take are the recent ones, so enough of them pushed every
	 * finished run past the line however recently it ran.
	 */
	readonly maxRuns: number;
	/**
	 * How long an unfinished run is kept before it is reclaimed anyway.
	 *
	 * A run whose reviewer never wrote a result is not terminal, and a
	 * terminal-only sweep can never reclaim it, so a run killed hard
	 * lives forever and the directory grows without bound. This window
	 * is deliberately separate from {@link maxAgeMs} and much longer:
	 * an unfinished run is kept for recovery, and the question is not
	 * whether it finished but whether anybody could still plausibly
	 * resume it. Omit to keep unfinished runs indefinitely, which is
	 * what the policy did before this existed.
	 *
	 * It does not reach a {@link protect}ed run. Nothing does.
	 */
	readonly abandonedAfterMs?: number;
	/**
	 * Runs no window may take, named by run id.
	 *
	 * For work that is finished on disk and unfinished to whoever is
	 * going to read it. A round detached from its session writes every
	 * result file and then waits, possibly for days, to be collected;
	 * to this sweep it looks exactly like a finished round nobody
	 * needs. Deleting it throws away reviews that have been paid for
	 * and leaves a ledger entry pointing at nothing.
	 *
	 * Protection is absolute rather than a longer window, because what
	 * a caller is asserting is that this run holds the only copy of
	 * something, and a clock does not make that untrue. What bounds a
	 * protected run is the caller taking it off the list. Ids are
	 * matched however they are spelled, since a caller holds run ids
	 * and these are stored under sanitized directory names: a miss
	 * here is not an error, it is a paid-for round quietly deleted.
	 */
	readonly protect?: ReadonlySet<string>;
	readonly now?: Date;
}

/** Summary returned by retention cleanup. */
export interface CleanupSummary {
	readonly removed: number;
	readonly kept: number;
	/**
	 * How many were kept because the caller protected them.
	 *
	 * Counted plainly, and deliberately not as "how many protection is
	 * costing": working that out means asking what each window would
	 * have said instead, and the answer depends on whether the run
	 * finished, which is the question protection skips. A first
	 * attempt guessed "finished" and so counted every unfinished
	 * protected run three weeks before its own window, while missing
	 * the case protection is genuinely unbounded along, which is a
	 * hundred fresh protected runs no age test will ever object to.
	 *
	 * So: the number of runs nothing may take. It is exact, it is the
	 * one population that grows without limit, and {@link kept} cannot
	 * show it because that folds it in with every run kept for being
	 * recent.
	 */
	readonly held: number;
	readonly warnings: readonly string[];
}

const SCHEMA_VERSION = 1;

/** File-backed artifact store for supervised reviewer runs. */
export class ReviewerArtifactsStore {
	readonly stateDir: string;
	readonly runsDir: string;

	constructor(stateDir: string) {
		this.stateDir = stateDir;
		this.runsDir = join(stateDir, "runs");
	}

	/** Return paths for a whole reviewer run. */
	rootPaths(runId: string): ReviewerRunRootPaths {
		const runDir = join(this.runsDir, safeSegment(runId));
		return {
			runDir,
			runPath: join(runDir, "run.json"),
			cancelPath: join(runDir, "cancel.json"),
			reviewersDir: join(runDir, "reviewers"),
		};
	}

	/** Return paths for one reviewer in a run. */
	paths(runId: string, reviewerId: string): ReviewerRunPaths {
		const root = this.rootPaths(runId);
		const reviewerDir = join(root.reviewersDir, safeSegment(reviewerId));
		return {
			runDir: root.runDir,
			reviewerDir,
			requestPath: join(reviewerDir, "request.json"),
			leasePath: join(reviewerDir, "lease.json"),
			cancelPath: join(reviewerDir, "cancel.json"),
			eventsPath: join(reviewerDir, "events.ndjson"),
			stderrPath: join(reviewerDir, "stderr.log"),
			progressPath: join(reviewerDir, "progress.json"),
			resultPath: join(reviewerDir, "result.json"),
			verifiedOutputPath: join(reviewerDir, "verified-output.json"),
			journalPath: join(reviewerDir, "journal.ndjson"),
			// What this reviewer was asked. Kept here rather than in a
			// temp file because a detached round has nobody to clean one
			// up, and because it is the only record of the question a
			// round that outlived its session was answering.
			promptPath: join(reviewerDir, "prompt.txt"),
			sessionDir: join(reviewerDir, "session"),
		};
	}

	/** Create the directories needed for a reviewer job. */
	async ensureReviewerDir(
		runId: string,
		reviewerId: string,
	): Promise<ReviewerRunPaths> {
		const paths = this.paths(runId, reviewerId);
		await mkdir(paths.reviewerDir, { recursive: true });
		return paths;
	}

	/** Write JSON by temp-file + rename so readers never see a partial object. */
	async writeJsonAtomic(path: string, value: unknown): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tmp, `${JSON.stringify(value, null, "\t")}\n`, "utf-8");
		await rename(tmp, path);
	}

	/** Read JSON, returning null for absent files. */
	async readJson<T>(path: string): Promise<T | null> {
		try {
			return JSON.parse(await readFile(path, "utf-8")) as T;
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}
	}

	/** Append bytes unless doing so would exceed the configured cap. */
	async appendCapped(
		path: string,
		chunk: Buffer,
		maxBytes: number,
	): Promise<AppendOutcome> {
		await mkdir(dirname(path), { recursive: true });
		const current = await fileSize(path);
		const bytesAfter = current + chunk.byteLength;
		if (bytesAfter > maxBytes) {
			return { written: false, bytesAfter, limitExceeded: true };
		}
		await writeFile(path, chunk, { flag: "a" });
		return { written: true, bytesAfter, limitExceeded: false };
	}

	/** Write a run-wide cancellation request. */
	async requestRunCancellation(runId: string, reason: string): Promise<void> {
		await this.writeJsonAtomic(this.rootPaths(runId).cancelPath, {
			schemaVersion: SCHEMA_VERSION,
			reason,
			requestedAt: new Date().toISOString(),
		});
	}

	/** Write a per-reviewer cancellation request. */
	async requestReviewerCancellation(
		runId: string,
		reviewerId: string,
		reason: string,
	): Promise<void> {
		await this.writeJsonAtomic(this.paths(runId, reviewerId).cancelPath, {
			schemaVersion: SCHEMA_VERSION,
			reason,
			requestedAt: new Date().toISOString(),
		});
	}

	/** Remove old terminal run directories according to a bounded policy. */
	async cleanupTerminalRuns(policy: RetentionPolicy): Promise<CleanupSummary> {
		const warnings: string[] = [];
		const entries = await listDirs(this.runsDir);
		// A run that goes while this is looking at it is dropped rather
		// than thrown over. Sessions sweep concurrently by design, so one
		// removing a directory between the listing and the stat is the
		// ordinary case, and it used to abort the sweep for everything
		// else in the directory.
		const seen = await Promise.all(
			entries.map(async (name) => {
				const runDir = join(this.runsDir, name);
				const mtimeMs = await mtimeOf(runDir);
				return mtimeMs === undefined ? undefined : { name, runDir, mtimeMs };
			}),
		);
		const runs = seen.filter((run) => run !== undefined);
		const sorted = runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
		// Why each one is being kept, worked out for all of them before
		// any of them is judged, because the count below has to rank a run
		// among the runs the count can actually take. In one pass rather
		// than one after another: this is a readdir and a stat per
		// reviewer, up to a hundred runs deep, on a path nobody is
		// awaiting at session start.
		const protect = new Set([...(policy.protect ?? [])].map(safeSegment));
		const keeping = await Promise.all(
			sorted.map(async (run): Promise<Keeping> => {
				// Protection first, since it is the stronger claim and the
				// cheaper question: a set lookup against a directory walk.
				if (protect.has(run.name)) return "protected";
				try {
					return (await isTerminalRun(run.runDir)) ? "spendable" : "unfinished";
				} catch (error) {
					// One directory nobody can walk must not cost the sweep
					// every other directory. Unfinished is the careful reading
					// of a run that cannot be asked whether it finished: it
					// buys the long window rather than the short one, and this
					// says so rather than deciding quietly.
					warnings.push(
						`Could not tell whether ${run.runDir} finished, so it is held as unfinished: ${errorMessage(error)}`,
					);
					return "unfinished";
				}
			}),
		);
		let removed = 0;
		let kept = 0;
		let held = 0;
		// How many runs the count could have taken so far. Counting every
		// directory instead let runs the count can never evict fill the
		// budget and push out ones it can: a hundred rounds open on a
		// ledger are all newer than a stale finished one, so every
		// finished round would be past the line however recently it ran.
		let spendable = 0;
		const now = policy.now?.getTime() ?? Date.now();
		for (let index = 0; index < sorted.length; index++) {
			const run = sorted[index];
			const why = keeping[index];
			const age = now - run.mtimeMs;
			// Where this one stands among the runs the count may take, and
			// nowhere at all if it is not one of them. Only a spendable run
			// advances the rank, which is what stops a kept one spending the
			// budget on everybody else's behalf.
			const place = why === "spendable" ? spendable++ : NOT_IN_THE_RUNNING;
			if (isSpent(policy, { age, place, keeping: why })) {
				try {
					await rm(run.runDir, { recursive: true, force: true });
					removed++;
				} catch (error) {
					warnings.push(
						`Failed to remove ${run.runDir}: ${errorMessage(error)}`,
					);
				}
			} else {
				kept++;
				if (why === "protected") held++;
			}
		}
		return { removed, kept, held, warnings };
	}
}

/**
 * Whether a run has outlived the reason to keep it.
 *
 * Three kinds of run and three answers. A protected one is never
 * spent: the caller has said its content is the only copy of
 * something somebody paid for, and no clock makes that untrue. An
 * unfinished one is kept while recovery is plausible and reclaimed
 * once it is not, which is the long window. Everything else is
 * finished and unclaimed, and gets the ordinary two.
 *
 * The long window was briefly extended over protected runs as well,
 * on the reasoning that nothing otherwise bounds them. That was
 * wrong, and worth writing down because it is a tempting mistake: a
 * round detached from its session writes its answers nowhere but
 * here until somebody collects it, so a sweep that took one on a
 * timer would delete the findings while leaving the ledger entry
 * that advertises them. What bounds these is a person, and every
 * listing tells them the round is unsettled.
 *
 * Separate from the loop because the loop is a filesystem walk and
 * this is the policy: one of them needs a disk to exercise and the
 * other needs three numbers.
 */
function isSpent(
	policy: RetentionPolicy,
	run: { age: number; place: number; keeping: Keeping },
): boolean {
	if (run.keeping === "protected") return false;
	if (run.keeping === "unfinished") {
		return (
			policy.abandonedAfterMs !== undefined && run.age > policy.abandonedAfterMs
		);
	}
	return run.age > policy.maxAgeMs || run.place >= policy.maxRuns;
}

/** Why a run is being kept, which decides what may take it. */
type Keeping = "protected" | "unfinished" | "spendable";

/**
 * The rank of a run the count cannot take.
 *
 * Below every threshold, so a policy that reads it still answers, and
 * answers that the count is not what would take this one.
 */
const NOT_IN_THE_RUNNING = Number.NEGATIVE_INFINITY;

/**
 * When a path was last written, or nothing if it is not there.
 *
 * Absence is an answer here rather than a failure: a concurrent sweep
 * removing a run directory is the expected case, not a fault.
 *
 * No test covers the window this guards, and it is worth saying so.
 * The gap is between the listing and this stat, inside one call, with
 * no seam to hold it open from outside, and a case that raced for it
 * would be a case that fails sometimes. So this is reasoned rather
 * than demonstrated: everything else here that touches the disk
 * tolerates a missing file, this was the one that did not, and what
 * it cost was the whole sweep plus, once the caller began reporting
 * failures, a loud message at session start about two windows having
 * been opened together.
 */
async function mtimeOf(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mtimeMs;
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
}

function safeSegment(value: string): string {
	const clean = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return clean.length > 0 ? clean : "unknown";
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch (error) {
		if (isNotFound(error)) return 0;
		throw error;
	}
}

async function listDirs(path: string): Promise<string[]> {
	try {
		const entries = await readdir(path, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
}

async function isTerminalRun(runDir: string): Promise<boolean> {
	const reviewersDir = join(runDir, "reviewers");
	const reviewers = await listDirs(reviewersDir);
	if (reviewers.length === 0) return false;
	for (const reviewer of reviewers) {
		try {
			await stat(join(reviewersDir, reviewer, "result.json"));
		} catch (error) {
			if (isNotFound(error)) return false;
			throw error;
		}
	}
	return true;
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
