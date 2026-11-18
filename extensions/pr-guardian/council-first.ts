/**
 * Sending a shell `gh pr` that puts a change in front of people to
 * review_offer, which holds it until our own council has read it.
 *
 * Joel, 17 November: "we must run our own reviews on everything before
 * asking for reviews from others". review_offer keeps that at every
 * door it has (extensions/review-integration/reviewed-first.ts), and
 * the shell had the same doors open beside it: `gh pr create` without
 * `--draft`, `gh pr create --reviewer`, `gh pr ready` and
 * `gh pr edit --add-reviewer`. Those are refused here, naming the
 * review_offer action that does the same thing once a council has
 * read the change. A draft with no reviewers, `gh pr ready --undo`,
 * `gh pr create --web` or `--dry-run` (nothing goes up until a person
 * submits the form, or at all) and every other `gh pr` go through.
 *
 * It refuses rather than reading the councils itself, because
 * review_offer is already the one door that knows a change's own
 * commits, and a second reading of them here could only disagree with
 * it.
 *
 * The flags are read as gh's own parser reads them: each one knows
 * whether it takes a value, so `--title --draft` is a title and not a
 * draft, a cluster such as `-fdr evan` is read letter by letter, and a
 * boolean given a value counts only when the value is true, so
 * `--draft=false` is no draft. Detection is broader than the reading,
 * so a `gh pr` inside a subshell, a brace group or control flow
 * reaches the fail-closed check that asks for a simpler form. Not
 * read: `gh api` calls that request reviewers, which name an endpoint
 * rather than a move; a command inside a quoted string handed to
 * another shell (`bash -c '...'`); and gh aliases.
 */

import {
	type SimpleCommand,
	tokenize,
	type Word,
} from "../../lib/command/index.ts";
import { refusalUnder } from "../../lib/guardian/apply.ts";
import type {
	CommandGuardian,
	GuardianBlock,
} from "../../lib/guardian/types.ts";
import { GUARDS } from "../../lib/internal/guardian/guards.ts";
import { unquote } from "../../lib/shell/index.ts";

/** One `gh pr` flag: its long name, its short letter, and whether it takes a value. */
interface GhFlag {
	readonly long: string;
	readonly short?: string;
	readonly takesValue: boolean;
}

/** A boolean flag, with its short letter when it has one. */
const on = (long: string, short?: string): GhFlag => ({
	long,
	takesValue: false,
	...(short ? { short } : {}),
});

/** A flag taking a value, with its short letter when it has one. */
const valued = (long: string, short?: string): GhFlag => ({
	long,
	takesValue: true,
	...(short ? { short } : {}),
});

/** Flags every `gh pr` subcommand takes. */
const EVERY_PR = [valued("repo", "R"), on("help", "h")];

/**
 * The flags of each subcommand this guard reads, as `gh pr <sub> --help`
 * lists them, so a value is never mistaken for a flag nor a flag for a
 * value.
 */
const FLAGS: Readonly<Record<string, readonly GhFlag[]>> = {
	create: [
		...EVERY_PR,
		valued("assignee", "a"),
		valued("base", "B"),
		valued("body", "b"),
		valued("body-file", "F"),
		on("draft", "d"),
		on("dry-run"),
		on("editor", "e"),
		on("fill", "f"),
		on("fill-first"),
		on("fill-verbose"),
		valued("head", "H"),
		valued("label", "l"),
		valued("milestone", "m"),
		on("no-maintainer-edit"),
		valued("project", "p"),
		valued("recover"),
		valued("reviewer", "r"),
		valued("template", "T"),
		valued("title", "t"),
		on("web", "w"),
	],
	ready: [...EVERY_PR, on("undo")],
	edit: [
		...EVERY_PR,
		valued("add-assignee"),
		valued("add-label"),
		valued("add-project"),
		valued("add-reviewer"),
		valued("base", "B"),
		valued("body", "b"),
		valued("body-file", "F"),
		valued("milestone", "m"),
		on("remove-milestone"),
		valued("remove-assignee"),
		valued("remove-label"),
		valued("remove-project"),
		valued("remove-reviewer"),
		valued("title", "t"),
	],
};

/** gh's other names for a subcommand. */
const ALIASES: Readonly<Record<string, string>> = { new: "create" };

/** pflag's words for true and false, as strconv.ParseBool reads them. */
const TRUE_WORDS = new Set(["1", "t", "T", "true", "TRUE", "True"]);

/** The flags a `gh pr` invocation set, by long name, with their values. */
type SetFlags = Map<string, string[]>;

/**
 * Read `words` as gh reads them against `flags`: each flag's values, a
 * boolean holding "true" or "false". A boolean given a value pflag
 * can't read is held as false, since gh refuses it and nothing runs.
 * Reading stops at `--`, after which every word is an argument.
 */
function readFlags(
	words: readonly string[],
	flags: readonly GhFlag[],
): SetFlags {
	const set: SetFlags = new Map();
	const keep = (flag: GhFlag, value: string) =>
		set.set(flag.long, [...(set.get(flag.long) ?? []), value]);
	const asBool = (value: string | undefined) =>
		value === undefined || TRUE_WORDS.has(value) ? "true" : "false";
	for (let i = 0; i < words.length; i++) {
		const word = words[i] ?? "";
		if (word === "--") break;
		if (word.startsWith("--")) {
			const eq = word.indexOf("=");
			const name = word.slice(2, eq < 0 ? undefined : eq);
			const attached = eq < 0 ? undefined : word.slice(eq + 1);
			const flag = flags.find((one) => one.long === name);
			if (!flag) continue;
			if (!flag.takesValue) keep(flag, asBool(attached));
			else if (attached !== undefined) keep(flag, attached);
			else keep(flag, words[++i] ?? "");
			continue;
		}
		if (!word.startsWith("-") || word === "-") continue;
		// A cluster, letter by letter: a letter taking a value takes the
		// rest of the word, or the next word, and ends the cluster.
		for (let at = 1; at < word.length; at++) {
			const flag = flags.find((one) => one.short === word[at]);
			if (!flag) continue;
			const rest = word.slice(at + 1);
			if (flag.takesValue) {
				keep(
					flag,
					rest.startsWith("=") ? rest.slice(1) : rest || (words[++i] ?? ""),
				);
				break;
			}
			if (rest.startsWith("=")) {
				keep(flag, asBool(rest.slice(1)));
				break;
			}
			keep(flag, "true");
		}
	}
	return set;
}

/** A shell `gh pr` that asks people to look, and what to use instead. */
export interface PeopleAsked {
	/** The move, as the refusal says it, e.g. `gh pr ready`. */
	readonly move: string;
	/** The review_offer action that makes the same move. */
	readonly instead: string;
	/** The `gh pr` command as written, which an override is kept for. */
	readonly command: string;
	/** What else the command did, which still wants running without the ask. */
	readonly besides?: string;
}

/** Programs that run the command after them, and how many words of their own each takes. */
const WRAPPERS: Readonly<Record<string, number>> = {
	command: 0,
	builtin: 0,
	exec: 0,
	env: 0,
	nohup: 0,
	nice: 0,
	time: 0,
	stdbuf: 0,
	xargs: 0,
	timeout: 1,
};

/**
 * Where gh's own arguments start in `words`, past any wrapper running
 * it (`timeout 60 gh`, `env FOO=1 gh`, `/usr/bin/gh`), or -1 when the
 * command isn't gh.
 */
function ghStart(words: readonly string[]): number {
	let i = 0;
	while (i < words.length) {
		const word = words[i] ?? "";
		if (word === "gh" || word.endsWith("/gh")) return i + 1;
		const own = WRAPPERS[word.slice(word.lastIndexOf("/") + 1)];
		if (own === undefined) return -1;
		i++;
		while (words[i]?.startsWith("-") || words[i]?.includes("=")) i++;
		i += own;
	}
	return -1;
}

/**
 * A command's words as the shell hands them over: unquoted, and cut at
 * an unquoted `#`, where a comment starts, since the tokenizer reads a
 * comment's words as arguments.
 */
function wordsOf(command: SimpleCommand): string[] {
	const end = command.argv.findIndex(
		(word: Word) => word.quoting === "none" && word.text.startsWith("#"),
	);
	return (end < 0 ? command.argv : command.argv.slice(0, end)).map((word) =>
		unquote(word.text),
	);
}

/**
 * The subcommand of `gh pr` and the words after it, past any `-R` given
 * before it, or nothing when `words` isn't a `gh pr`.
 */
function subcommandOf(
	words: readonly string[],
): { sub: string; rest: string[] } | undefined {
	const start = ghStart(words);
	if (start < 0 || words[start] !== "pr") return undefined;
	let i = start + 1;
	while (words[i]?.startsWith("-")) {
		const word = words[i] ?? "";
		const valueNext = word === "-R" || word === "--repo";
		i += valueNext ? 2 : 1;
	}
	const said = words[i];
	if (said === undefined) return undefined;
	return { sub: ALIASES[said] ?? said, rest: words.slice(i + 1) };
}

/** What a `gh pr` command asks of people, or null when it asks nothing. */
function asks(words: readonly string[], command: string): PeopleAsked | null {
	const found = subcommandOf(words);
	if (!found) return null;
	const flags = FLAGS[found.sub];
	if (!flags) return null;
	const set = readFlags(found.rest, flags);
	const is = (name: string) => set.get(name)?.at(-1) === "true";
	switch (found.sub) {
		case "create":
			// Nothing goes up from the shell: --web leaves it to a person
			// submitting the form in the browser, --dry-run sends nothing.
			if (is("web") || is("dry-run")) return null;
			if (set.has("reviewer"))
				return {
					move: "gh pr create --reviewer",
					instead: "review_offer propose, then review_offer reviewers",
					command,
				};
			if (!is("draft"))
				return {
					move: "gh pr create without --draft",
					instead: "review_offer propose with draft: false",
					command,
				};
			return null;
		case "ready":
			return is("undo")
				? null
				: { move: "gh pr ready", instead: "review_offer ready", command };
		case "edit": {
			if (!set.has("add-reviewer")) return null;
			const others = [...set.keys()].filter(
				(name) => name !== "add-reviewer" && name !== "repo",
			);
			return {
				move: "gh pr edit --add-reviewer",
				instead: "review_offer reviewers",
				command,
				...(others.length > 0
					? {
							besides: `its other edits (${others.map((name) => `--${name}`).join(", ")}) still want running, as a gh pr edit without --add-reviewer`,
						}
					: {}),
			};
		}
		default:
			return null;
	}
}

/** The first `gh pr` in a command line that asks people to look. */
export function peopleAsked(command: string): PeopleAsked | null {
	const line = tokenize(command);
	for (const one of line.commands) {
		const written = line.source.slice(one.span.start, one.span.end);
		const asked = asks(wordsOf(one), written);
		if (asked) return asked;
	}
	return null;
}

/**
 * Whether a command line, with its quoted data stripped as the gate
 * hands it over, might hold a `gh pr`. Broader than the reading on
 * purpose: one inside a subshell or control flow, or with its words
 * quoted, has to reach the fail-closed check rather than slip past it.
 */
export function mightAskPeople(stripped: string): boolean {
	return (
		/(?:^|[^\w.-])gh(?:$|[^\w.-])/.test(stripped) &&
		/\bpr\b|''|""/.test(stripped)
	);
}

/** The refusal, naming the review_offer action to use instead. */
function refusal(asked: PeopleAsked): GuardianBlock {
	return {
		block: true,
		reason:
			`${asked.move} puts the change in front of people, and the shell ` +
			"can't tell whether our own council has read it. Use " +
			`${asked.instead}: it goes ahead once a finished council of ours ` +
			"has read one of the change's own commits, and says what to run " +
			"when none has." +
			(asked.besides ? ` Note that ${asked.besides}.` : "") +
			" A draft with no reviewers (gh pr create --draft) still goes " +
			"up from the shell.",
	};
}

/** Guardian refusing a shell `gh pr` that asks people before our council. */
export const councilFirstGuardian: CommandGuardian<PeopleAsked> = {
	detect: mightAskPeople,
	parse: peopleAsked,
	review: async (asked) =>
		refusalUnder(
			GUARDS.councilFirst.name,
			refusal(asked),
			"gh pr before our council",
			asked.command,
		),
};
