/**
 * script(1)'s words for running a command in a terminal of its own, in
 * whichever spelling the PATH's script speaks. util-linux's takes the
 * command after -c and runs it through `$SHELL -c`; a Mac's BSD one
 * refuses -f and -c ("illegal option -- f", 67FEB45D, 27 November) and
 * takes the command's own words after its file. Both flush as they write
 * and end with the command's status. The host cases were probed on
 * util-linux 2.38 and 2.42, so a Mac with util-linux first on its PATH
 * runs that one.
 */

import { spawnSync } from "node:child_process";

/** Which script(1) the PATH holds: util-linux's, or the BSD one a Mac ships. */
export type ScriptKind = "util-linux" | "bsd";

/** What a case says when the PATH holds no script(1). */
export const NO_SCRIPT = "No script(1) on the PATH: put util-linux on it";

let asked: ScriptKind | undefined | null = null;

/**
 * The PATH's script(1), asked once: util-linux's prints its version for
 * -V, where BSD's refuses the option, prints its usage and starts
 * nothing. None at all is undefined.
 */
export function scriptKind(): ScriptKind | undefined {
	if (asked === null)
		asked = kindOf(spawnSync("script", ["-V"], { encoding: "utf8" }));
	return asked;
}

/** The kind a run of `script -V` shows, from what it printed or that it couldn't start. */
export function kindOf(run: {
	readonly error?: Error;
	readonly stdout?: string | null;
}): ScriptKind | undefined {
	if (run.error !== undefined) return undefined;
	return run.stdout?.includes("util-linux") ? "util-linux" : "bsd";
}

/**
 * The arguments that run `command`, a line for sh, quietly in a terminal
 * of its own that keeps no typescript, for script(1) of `kind`.
 */
export function scriptWords(kind: ScriptKind, command: string): string[] {
	if (kind === "util-linux") return ["-qfec", command, "/dev/null"];
	return ["-qeF", "/dev/null", "/bin/sh", "-c", command];
}

/** The arguments for the PATH's script(1), refusing when it holds none. */
export function scriptArgs(command: string): string[] {
	const kind = scriptKind();
	if (kind === undefined) throw new Error(NO_SCRIPT);
	return scriptWords(kind, command);
}
