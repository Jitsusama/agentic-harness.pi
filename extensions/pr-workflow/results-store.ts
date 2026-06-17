/**
 * Durable parsed-results store for pr-workflow run bodies.
 *
 * Council, judge and critique run bodies carry the full
 * reviewer transcripts and are the heavy part of the workflow
 * state. Embedding them in the append-only session log meant
 * every persist re-wrote the whole transcript; over a session
 * that dominated the log. This store holds each body in its own
 * flat file under `<stateDir>/results/<id>.json`, written once
 * and keyed by the run id that already exists on every run, so
 * the session snapshot can carry a lightweight pointer instead.
 *
 * The id is the natural join key, which also makes forks correct
 * for free: a forked or branched session inherits the pointer
 * and reads the same shared file.
 *
 * IO is synchronous on purpose. The bodies are small and the
 * callers (`persist` and `restore`) are synchronous; sync fs
 * keeps their contract unchanged rather than rippling async
 * through every event handler that touches state.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

	/** Read a run body by id, returning null when no file exists. */
	readRun<T>(runId: string): T | null {
		try {
			return JSON.parse(readFileSync(this.pathFor(runId), "utf-8")) as T;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	private pathFor(runId: string): string {
		return join(this.resultsDir, `${safeSegment(runId)}.json`);
	}
}

/** Reduce a run id to a filesystem-safe path segment. */
function safeSegment(value: string): string {
	const clean = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return clean.length > 0 ? clean : "unknown";
}
