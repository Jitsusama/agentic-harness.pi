/**
 * Session state for the verification workflow: the files
 * touched during the current run, the errors still
 * outstanding, how many times the fast layer has asked the
 * agent to fix them in a row, what each checked file last
 * answered, the last check run that failed, and the last
 * outcome for the status line.
 */

import type { FileError } from "../../lib/verification/index.ts";

/** The last thing verification concluded, for the status line. */
export type VerifyOutcome = "unknown" | "clean" | "failing" | "deferred";

/**
 * A run of the project's check command that found the code failing,
 * kept with what the tree looked like then so a commit is only held
 * back by it while it still describes the tree.
 */
export interface FailedRun {
	/** The project directory the command ran in. */
	readonly root: string;
	readonly command: string;
	/**
	 * The tree's fingerprint when it ran; absent outside git, where an
	 * edit under root is what retires the run instead.
	 */
	readonly fingerprint?: string;
}

/** Mutable per-session verification state. */
export interface VerificationState {
	/** Absolute paths edited or written during the current turn. */
	touched: Set<string>;
	/** Errors still outstanding on files this loop is watching. */
	pending: FileError[];
	/** Consecutive fast-layer fix requests since the last clean pass. */
	attempts: number;
	/**
	 * The errors each file had when it was last checked, for the files
	 * that had any. A commit re-checks these rather than trusting them.
	 */
	known: Map<string, FileError[]>;
	/** The last check run that found the code failing, if any. */
	failedRun?: FailedRun;
	/** The file edited most recently, which says where the work is. */
	lastEdited?: string;
	/** Last outcome, for the status line. */
	outcome: VerifyOutcome;
	/**
	 * The error set the fast layer last told the model about, as
	 * {@link errorSetKey} spells it. The same set is not said twice:
	 * the model has it already, and the footer still says it fails.
	 */
	lastSaid?: string;
}

/**
 * An error set, said the same whatever order it arrived in and
 * wherever its lines moved to, since an edit above an error moves it
 * without changing it.
 */
export function errorSetKey(errors: readonly FileError[]): string {
	return errors
		.map((error) => `${error.path}\u0000${error.message}`)
		.sort()
		.join("\u0001");
}

/** The number of fix requests before the loop gives up and hands back. */
export const MAX_FIX_ATTEMPTS = 3;

/**
 * How long the fast layer may hold the end of a turn, over every file
 * it checks. The loop waits on it before handing the turn back, so a
 * server that stops answering must cost this much and no more.
 */
export const FAST_LAYER_WALL_MS = 30_000;

/**
 * How long a commit waits on the language server to re-check the
 * files that last had errors. A file it does not reach in time is not
 * held against the commit, since nothing confirmed it still fails.
 */
export const COMMIT_CHECK_WALL_MS = 10_000;

/** Create the initial verification state. */
export function createVerificationState(): VerificationState {
	return {
		touched: new Set(),
		pending: [],
		attempts: 0,
		known: new Map(),
		outcome: "unknown",
	};
}
