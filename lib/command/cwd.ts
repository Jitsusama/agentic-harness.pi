/**
 * Effective working directory of a command line: the base cwd
 * composed with the leading `cd` segments. Consumers that resolve a
 * relative path (the `git commit -F <file>` reader, say) ask here
 * instead of scraping the first `cd` with a regex.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { CommandLine, Word } from "./types.js";

/** The resolved directory, or a signal that it cannot be resolved. */
export type EffectiveCwd =
	| { dir: string }
	| { unresolvable: true; reason: string };

/** Compose the base cwd with each cd segment in the command line. */
export function effectiveCwd(line: CommandLine, baseCwd: string): EffectiveCwd {
	let dir = baseCwd;
	for (const command of line.commands) {
		if (command.argv[0]?.text !== "cd") continue;
		const targetWord = command.argv[1];
		if (!targetWord) continue;

		const target = literalTarget(targetWord);
		if (target === undefined) {
			return {
				unresolvable: true,
				reason: `cd target ${targetWord.text} is not statically resolvable`,
			};
		}
		dir = applyCd(dir, target);
	}
	return { dir };
}

/**
 * The literal directory a cd target names, or undefined when it
 * depends on a variable, command substitution or glob we cannot
 * resolve statically.
 */
function literalTarget(word: Word): string | undefined {
	if (word.quoting === "single") return word.text.slice(1, -1);
	if (word.quoting === "double") {
		const inner = word.text.slice(1, -1);
		return /[$`]/.test(inner) ? undefined : inner;
	}
	if (word.quoting === "none") {
		return /[$`*?[\]{}]/.test(word.text) ? undefined : word.text;
	}
	return undefined;
}

/** Apply one resolved cd target to the running directory. */
function applyCd(dir: string, target: string): string {
	if (target === "~") return homedir();
	if (target.startsWith("~/")) return join(homedir(), target.slice(2));
	return isAbsolute(target) ? target : resolve(dir, target);
}
