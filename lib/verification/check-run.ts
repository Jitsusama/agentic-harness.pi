/**
 * What a run of the project's check command says about the code.
 *
 * A command that failed because the code is wrong and one that failed
 * because it could never start look alike: both exit non-zero. Only
 * the first says anything about the code. A checkout with no
 * node_modules answers "biome: command not found" whatever is in it,
 * and reading that as failing blocked commits on code nobody had
 * checked.
 */

/** The parts of a check run the verdict reads. */
export interface CheckRun {
	readonly ok: boolean;
	/** The command that ran; absent when no check command was found. */
	readonly command?: string;
	readonly output: string;
}

/** The verdict on a check run. */
export type CheckRunVerdict =
	| { readonly outcome: "clean" }
	| { readonly outcome: "failing" }
	| { readonly outcome: "deferred"; readonly reason: string };

/**
 * What a shell or package manager prints when the check could not
 * start, rather than when it ran and found something. A warning that
 * node_modules is missing is not on the list: a package manager prints
 * it ahead of a check that then runs and fails on its merits.
 */
const COULD_NOT_START: readonly RegExp[] = [
	// Exit 127 is every POSIX shell's "no such command".
	/^Failed \(exit 127\):/,
	// bash, then dash, which is /bin/sh on Debian and Ubuntu. A package
	// manager that wraps the shell exits 1, so the message is all there is.
	/: command not found\b/,
	/^\S+: \d+: [^:]+: not found$/,
	/\bCommand "[^"]+" not found\b/,
	/\bspawn \S+ ENOENT\b/,
];

/** Whether a check run judged the code, and if so how it found it. */
export function checkRunVerdict(run: CheckRun): CheckRunVerdict {
	if (run.ok) return { outcome: "clean" };
	if (!run.command) {
		return { outcome: "deferred", reason: "no check command was found" };
	}
	const line = run.output
		.split("\n")
		.find((l) => COULD_NOT_START.some((pattern) => pattern.test(l)));
	if (line !== undefined) {
		return {
			outcome: "deferred",
			reason: `the check could not start: ${line.trim()}`,
		};
	}
	return { outcome: "failing" };
}
