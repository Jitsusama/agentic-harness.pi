/**
 * Durable parsed-results store for pr-workflow run bodies.
 *
 * Council, judge and critique run bodies carry the full
 * reviewer transcripts and are the heavy part of the workflow
 * state. Embedding them in the append-only session log meant
 * every persist re-wrote the whole transcript; over a session
 * that dominated the log. This store holds each body in its own
 * flat file under `<stateDir>/results/`, keyed by the run id
 * that already exists on every run, so the session snapshot can
 * carry a lightweight pointer instead. A body is written when it
 * first appears and again only if it is edited in place (a
 * council-retry reuses the run id), not on every persist.
 *
 * The id is the natural join key, which also makes forks correct
 * for free: a forked or branched session inherits the pointer
 * and reads the same shared file.
 *
 * Run ids are unique per run, so superseded bodies linger
 * unreferenced; `cleanup` bounds the directory on activation by
 * pruning old surplus while keeping every recent body.
 *
 * IO is synchronous on purpose: the callers (`persist` and
 * `restore`) are synchronous, and sync fs keeps their contract
 * unchanged rather than rippling async through every event
 * handler that touches state.
 */

import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** A run body carries a stable id that names its file. */
interface RunWithId {
	readonly id: string;
}

/**
 * The store contract `persist` and `restore` depend on. Keeping
 * it an interface lets the lifecycle tests substitute an
 * in-memory double without touching the filesystem.
 */
export interface RunBodyStore {
	writeRun<T extends RunWithId>(run: T): void;
	readRun<T>(runId: string): T | null;
}

/** File-backed store for parsed run bodies, keyed by run id. */
export class ResultsStore implements RunBodyStore {
	private readonly resultsDir: string;

	constructor(stateDir: string) {
		this.resultsDir = join(stateDir, "results");
	}

	/**
	 * Write a run body to `results/<id>.json` via temp-file plus
	 * rename, so a reader never sees a partially written object.
	 * Overwrites any existing body for the same id.
	 */
	writeRun<T extends RunWithId>(run: T): void {
		const path = this.pathFor(run.id);
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(run, null, "\t")}\n`, "utf-8");
		renameSync(tmp, path);
	}

	/**
	 * Read a run body by id. Returns null when the file is absent
	 * or its contents are not valid JSON (a truncated or corrupt
	 * body), so a damaged transcript degrades to the same
	 * missing-body path rather than crashing the caller.
	 */
	readRun<T>(runId: string): T | null {
		let raw: string;
		try {
			raw = readFileSync(this.pathFor(runId), "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		try {
			return JSON.parse(raw) as T;
		} catch {
			// A corrupt or truncated body is treated as missing: the
			// restore path already degrades gracefully on null.
			return null;
		}
	}

	/**
	 * Bound the results directory. A file is pruned only when it
	 * is both older than `maxAgeMs` and beyond the newest
	 * `maxFiles` by modification time, so a recent body, which is
	 * the kind a live snapshot still points at, is never pruned.
	 * That keeps the sweep safe to run blind at activation without
	 * knowing which ids are still referenced: a body that is
	 * current is recent, and a body old enough to prune has long
	 * since been superseded. Best-effort, so a file that vanishes
	 * or refuses to delete mid-sweep is skipped rather than fatal.
	 */
	cleanup(policy: { maxFiles: number; maxAgeMs: number; now?: Date }): {
		removed: number;
		kept: number;
	} {
		const now = (policy.now ?? new Date()).getTime();
		let names: string[];
		try {
			names = readdirSync(this.resultsDir).filter((f) => f.endsWith(".json"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { removed: 0, kept: 0 };
			}
			throw error;
		}
		const files = names
			.map((name) => {
				const path = join(this.resultsDir, name);
				return { path, mtimeMs: statSync(path).mtimeMs };
			})
			.sort((a, b) => b.mtimeMs - a.mtimeMs);

		let removed = 0;
		files.forEach((file, index) => {
			const tooOld = now - file.mtimeMs > policy.maxAgeMs;
			const surplus = index >= policy.maxFiles;
			if (!(tooOld && surplus)) return;
			try {
				rmSync(file.path);
				removed++;
			} catch {
				// A file that vanished or refuses to delete is left in
				// place; the sweep is advisory, not load-bearing.
			}
		});
		return { removed, kept: files.length - removed };
	}

	private pathFor(runId: string): string {
		// A readable segment for humans browsing the directory, plus
		// a hash of the full id so two ids that sanitise to the same
		// segment cannot alias onto one file. The hash is
		// deterministic, so a fork computes the same path and shares
		// the file.
		const digest = createHash("sha256")
			.update(runId)
			.digest("hex")
			.slice(0, ID_HASH_LENGTH);
		return join(this.resultsDir, `${safeSegment(runId)}-${digest}.json`);
	}
}

/** Hex characters of the id hash folded into each file name. */
const ID_HASH_LENGTH = 12;

/** Reduce a run id to a filesystem-safe path segment. */
function safeSegment(value: string): string {
	const clean = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return clean.length > 0 ? clean : "unknown";
}
