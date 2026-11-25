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

/**
 * The options of `env` that take the word after them as their own:
 * GNU's, and the BSD env's of macOS (`-P`, `-L`, `-U`).
 */
const TAKES_A_WORD = new Set([
	"-u",
	"--unset",
	"-C",
	"--chdir",
	"-P",
	"-L",
	"-U",
]);

/** The options of `env` whose word is the command and its arguments. */
const SPLITS = new Set(["-S", "--split-string"]);

/** Whether `command` names git, by its name or its path. */
const isGit = (command: string): boolean =>
	command === "git" || command.endsWith("/git");

/**
 * Whether `command` runs git, itself or through `env`: the first word
 * past env's options, their own words and its settings, or the first
 * word of the string `-S` splits and the words after it.
 */
function runsGit(command: string, args: readonly string[]): boolean {
	if (isGit(command)) return true;
	if (command !== "env" && !command.endsWith("/env")) return false;
	for (let at = 0; at < args.length; at++) {
		const arg = args[at] ?? "";
		if (SPLITS.has(arg)) {
			const split = (args[at + 1] ?? "").trim().split(/\s+/);
			return runsGit("env", [...split, ...args.slice(at + 2)]);
		}
		if (TAKES_A_WORD.has(arg)) {
			at++;
		} else if (!arg.startsWith("-") && !arg.includes("=")) {
			return isGit(arg);
		}
	}
	return false;
}
