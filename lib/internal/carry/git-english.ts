/**
 * Which of carrying's commands run in English whatever this machine's
 * language: git's, since what git says is matched, as an arrival reads
 * a branch origin lacks, and passed on as a refusal's reason. Git run
 * through `env`, as a tree's changes are taken on an index of their
 * own, is still git. What else runs, such as lsof naming files, keeps
 * its own locale, and the git an arrival feeds lines through sh sets it
 * there itself.
 */

import type { Exec } from "../../core/exec/index.ts";

/** An exec running git through `english`, and anything else `asItIs`. */
export function gitInEnglish(english: Exec, asItIs: Exec): Exec {
	return (command, args) =>
		(runsGit(command, args) ? english : asItIs)(command, args);
}

/** The options of `env` that take the word after them as their own. */
const TAKES_A_WORD = new Set(["-u", "--unset", "-C", "--chdir"]);

/**
 * Whether `command` runs git, itself or through `env`: the first word
 * past env's options, their own words and its settings.
 */
function runsGit(command: string, args: readonly string[]): boolean {
	if (command === "git") return true;
	if (command !== "env") return false;
	for (let at = 0; at < args.length; at++) {
		const arg = args[at] ?? "";
		if (TAKES_A_WORD.has(arg)) {
			at++;
		} else if (!arg.startsWith("-") && !arg.includes("=")) {
			return arg === "git";
		}
	}
	return false;
}
