/**
 * What pi-verbs is asked, read from its words alone, before it looks for
 * its socket, so its help and a wrong asking answer on any machine.
 */

import { nearestWord } from "../nearest.ts";

/** What `pi-verbs --help` says, each line within 72 columns. */
export const VERBS_HELP = `pi-verbs serves the verbs the launcher offers on a selection,
and asks them as an agent or a test would.

Usage:
  pi-verbs serve
  pi-verbs list
  pi-verbs ask VERB [NAME=WORDS ...] < selection
  pi-verbs told USE accepted|undone|dismissed

Commands:
  serve   listen on the socket systemd holds, or its own in the
          login's runtime folder
  list    print the verbs offered now, as JSON
  ask     ask one verb of the selection on stdin, printing its answer
  told    say how a verb's use ended

It exits 0 when answered, 1 when an ask is refused, 64 when asked
wrongly, naming the nearest command, and 78 when there is no runtime
folder to find the socket in.
`;

/** Each command's own usage, said when its words are wrong. */
const USAGES = {
	serve: "usage: pi-verbs serve",
	list: "usage: pi-verbs list",
	ask: "usage: pi-verbs ask VERB [NAME=WORDS ...] < selection",
	told: "usage: pi-verbs told USE accepted|undone|dismissed",
} as const;

/** The commands pi-verbs knows, in the order its help names them. */
const COMMANDS = Object.keys(USAGES);

/** What pi-verbs' words ask for. */
export type VerbsAsked =
	| { readonly help: true }
	| { readonly serve: true }
	| {
			readonly line: Record<string, unknown>;
			/** The ask carries the selection, read from stdin. */
			readonly selection?: true;
	  }
	| { readonly wrong: string };

/**
 * What `words` ask of pi-verbs: its help when any is `--help` or `-h`,
 * serving, a line to ask the server, or what is wrong with them.
 */
export function verbsAsked(words: readonly string[]): VerbsAsked {
	if (words.some((word) => word === "--help" || word === "-h")) {
		return { help: true };
	}
	const [command, ...rest] = words;
	if (command === undefined) return { wrong: "pi-verbs wants a command" };
	if (command === "serve" && rest.length === 0) return { serve: true };
	if (command === "list" && rest.length === 0) {
		return { line: { ask: "watch" } };
	}
	if (command === "told" && rest.length === 2) {
		return { line: { ask: "told", use: rest[0], outcome: rest[1] } };
	}
	if (command === "ask" && rest[0]) {
		const args = pairs(rest.slice(1));
		if (args) {
			return { line: { ask: "verb", verb: rest[0], args }, selection: true };
		}
	}
	if (isCommand(command)) return { wrong: USAGES[command] };
	const near = nearestWord(command, COMMANDS);
	return {
		wrong: `pi-verbs has no command ${command}${near ? `; did you mean ${near}?` : ""}`,
	};
}

/** Whether `word` is one of pi-verbs' commands, never a name its prototype holds. */
function isCommand(word: string): word is keyof typeof USAGES {
	return Object.hasOwn(USAGES, word);
}

/** `NAME=WORDS` pairs as a record, or none when one isn't a pair. */
function pairs(words: readonly string[]): Record<string, string> | undefined {
	const args: Record<string, string> = {};
	for (const pair of words) {
		const at = pair.indexOf("=");
		if (at <= 0) return undefined;
		args[pair.slice(0, at)] = pair.slice(at + 1);
	}
	return args;
}
