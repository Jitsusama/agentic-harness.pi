/**
 * A shell command that only waits: it sleeps, reads and reports, and
 * changes nothing a session would lose if it stopped. On 23 November
 * seven carries an orchestrator ordered were all refused because each
 * session held a heavy lease on its own poll loop (`while ! grep -q rc=
 * log; do sleep 10; done`), since every background command claimed one.
 * A wait claims none, so a carry stops it and says so; anything this
 * can't read as a wait still claims, as a build, a push or a script
 * nothing here can see into does.
 */

import { shellSteps } from "./steps.ts";

/** The words a step that only waits or reads may start with. */
const WAITS = new Set([
	":",
	"sleep",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"tail",
	"head",
	"cat",
	"wc",
	"cut",
	"tr",
	"sort",
	"uniq",
	"date",
	"echo",
	"printf",
	"test",
	"[",
	"[[",
	"]]",
	"true",
	"false",
	"break",
	"continue",
	"exit",
	"seq",
	"ls",
	"stat",
	"readlink",
	"jq",
	"journalctl",
	"pgrep",
	"ps",
	"read",
	"cd",
]);

/**
 * The forms of a word of {@link WAITS} that write or run a program, by
 * the rest of the step (ISXEG8, 23 November): such a step claims. Long
 * options are matched by the shortest prefix getopt takes for each.
 */
const WRITES: Readonly<Record<string, (rest: readonly string[]) => boolean>> = {
	// --pre and --hostname-bin run a program.
	rg: (rest) => rest.some((word) => /^--(?:pre|hostname-bin)/.test(word)),
	// -o and --output write, --compress-program runs a program.
	sort: (rest) => rest.some((word) => /^(?:-[^-]*o|--o|--co)/.test(word)),
	// A second file named is written, `-` standing for the first.
	uniq: (rest) => operands(rest, "fsw", /^--(?:sk|ch)/).length > 1,
	// Vacuum, rotate, flush, sync, relinquish-var, update-catalog and
	// setup-keys change it, and --cursor-file writes where it read to.
	journalctl: (rest) =>
		rest.some((word) => /^--(?:va|rot|fl|syn|rel|sm|up|se|cursor-)/.test(word)),
	// -s and --set set the clock; -d, -f, -r and -I take the rest of
	// their word, as `date -Is` does.
	// An operand but a `+` format sets it too, as `date 11230440` does.
	date: (rest) =>
		rest.some(
			(word) =>
				/^--s/.test(word) ||
				(/^-[^-]/.test(word) && /^[^dfrI]*s/.test(word.slice(1))),
		) ||
		operands(
			// -I takes the rest of its word only, so `date -Is 11230440` sets it.
			rest.map((word) =>
				/^-[^-]/.test(word) ? word.replace(/I.*/, "I") : word,
			),
			"dfrs",
			/^--(?:da|fi|ref|rfc-3|se)/,
		).some((word) => !word.replace(/^@/, "").startsWith("+")),
};

/**
 * A command's operands as getopt reads them: `-` and every word past
 * `--` are operands; a short option of `takesWord` takes the rest of its
 * word, or the next word where nothing follows it there, and so does a
 * long one matching `long` without an `=`.
 */
function operands(
	rest: readonly string[],
	takesWord: string,
	long: RegExp,
): string[] {
	const found: string[] = [];
	let skip = false;
	let ended = false;
	for (const word of rest) {
		if (skip) {
			skip = false;
		} else if (ended || word === "-" || !word.startsWith("-")) {
			found.push(word);
		} else if (word === "--") {
			ended = true;
		} else if (word.startsWith("--")) {
			skip = long.test(word) && !word.includes("=");
		} else {
			const letters = word.slice(1);
			const at = [...letters].findIndex((one) => takesWord.includes(one));
			skip = at === letters.length - 1;
		}
	}
	return found;
}

/** An operator `[[` reads both sides of as arithmetic. */
const COMPARES = /^-(?:eq|ne|lt|le|gt|ge)$/;

/**
 * What makes a word split or expand into several: a variable or a brace
 * outside double quotes, marked by {@link onlyWaits} before the steps
 * are split, which takes the quotes out.
 */
const SPLITS = /[${]~/;

/** A test of whether a name is set, which reads a subscript as arithmetic. */
const NAMED = /^-[vR]$/;

/** An operator test and `[` take literally, after which a word is its operand. */
const OPERATOR = /^(?:-[a-zA-Z]+|!?=|==|<|>)$/;

/** An operator test and `[` read between two operands. */
const BINARY = /^(?:-(?:eq|ne|lt|le|gt|ge|nt|ot|ef|a|o)|!?=|==|<|>)$/;

/**
 * Whether test or `[` could be made to test whether a name is set: it
 * names `-v` or `-R`, or a word read from a variable stands where such
 * an operator could, neither the operand of an operator nor beside a
 * binary one.
 */
function mayTestName(rest: readonly string[]): boolean {
	const words = rest.filter((word) => word !== "]");
	// An unquoted variable may split into `-v` and its name, as
	// `x='-v a[$(>y)]'; test $x` does, and so may a brace word.
	if (words.some((word) => NAMED.test(word) || SPLITS.test(word))) {
		return true;
	}
	if (words.length < 2) return false;
	return words.some(
		(word, at) =>
			UNREADABLE.test(word) &&
			!OPERATOR.test(words[at - 1] ?? "") &&
			!BINARY.test(words[at + 1] ?? ""),
	);
}

/**
 * The forms of a word of {@link WAITS} that read a name's value as
 * arithmetic, which runs any substitution the value holds, as
 * `n='a[$(touch x)]'; [[ $n -eq 1 ]]` does (ISXEG8, 23 November): such
 * a step claims. A number compared in `[[` reads nothing.
 */
const EVALUATES: Readonly<
	Record<string, (rest: readonly string[]) => boolean>
> = {
	"[[": (rest) =>
		rest.some(
			(word, at) =>
				NAMED.test(word) ||
				(COMPARES.test(word) &&
					![rest[at - 1], rest[at + 1]].every((side) =>
						/^\d+$/.test(side ?? ""),
					)),
		),
	test: mayTestName,
	"[": mayTestName,
	// A name read into may hold a subscript.
	read: (rest) => rest.some((word) => UNREADABLE.test(word)),
	// -v names a variable to print into, and a variable or a brace word
	// could be -v; past the format, an unquoted one claims as in test.
	printf: (rest) =>
		/^-v|[${]/.test(rest[0] ?? "") || rest.some((word) => SPLITS.test(word)),
};

/**
 * What makes a word of one of {@link WRITES} unreadable: a variable or
 * substitution, a glob, or a quote or backslash, any of which could
 * make an option of it, so such a step claims.
 */
const UNREADABLE = /[$*?[\]{\\"']/;

/** What systemctl may be asked and still only read. */
const SYSTEMCTL_READS = new Set(["status", "is-active", "is-failed", "show"]);

/**
 * The options systemctl may be given before what it is asked, none of
 * which takes the word after it, so the first other word is what it is
 * asked: one taking a word, as `-p status restart`, could hide it.
 */
const SYSTEMCTL_FLAGS =
	/^(?:--user|--system|--no-pager|--no-legend|--quiet|-q|--full|-l|--all|-a|--value|--plain)$/;

/** The shell's own words around a step's command, which run nothing. */
const KEYWORD =
	/^(?:do|done|then|else|elif|fi|if|while|until|!|\{|\}|\(|\)|\(\(|\)\))(?:\s+|$)/;

/** A variable set before a step's command, as `n=0` or `export a=b`. */
const ASSIGNMENT = /^(?:export\s+)?[A-Za-z_]\w*=\S*(?:\s+|$)/;

/** A time limit or a changed environment a step's command runs under. */
const UNDER =
	/^(?:timeout(?:\s+-[sk]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+\S+|env(?:\s+-u\s+\S+|\s+[A-Za-z_]\w*=\S*)*)(?:\s+|$)/;

/** A loop over words, which runs nothing but its substitutions. */
const FOR = /^for\s+[A-Za-z_]\w*(?:\s+in\b.*)?$/;

/**
 * A redirect, its target in the first group: empty where a quoted
 * target was taken out, which then can't be read.
 */
const REDIRECT = /(?:\d|&)?>[>|]?\s*(\S*)/g;

/** Where a redirect may write and change nothing. */
const HARMLESS = /^(?:\/dev\/null|&[12])\)*$/;

/** Arithmetic on numbers alone, `$((...))`, which runs nothing. */
const ARITHMETIC = /\$\(\([\d\s+\-*/%<>=!&|^~?:,]*\)\)/g;

/**
 * Where bash reads a name's value as arithmetic, which runs any
 * substitution the value holds: `((...))`, `$[...]`, and any `${...}`
 * but a plain name, its length, a default or a pattern, since a
 * subscript, an offset or an indirection is read as arithmetic.
 */
const EVALUATED =
	/(?:^|[^$])\(\(|\$\[|\$\{(?!#?[A-Za-z_]\w*(?:\}|[#%/^,]|:?[-=+?]))|\w\+?=\(/;

/** A `[[ ... ]]` test, its words in the first group. */
const DOUBLE_TEST = /\[\[(.*?)\]\]/gs;

/**
 * A command's quoting, read left to right as the shell reads it: a
 * single-quoted word, a double-quoted one, an escaped character, a
 * comment (what comes before it in the second group), or a quote that
 * pairs with none.
 */
const QUOTING =
	/'[^']*'|"(?:[^"\\]|\\[\s\S])*"|\\[\s\S]|(^|[\s;&|(])#[^\n]*|['"]/g;

/**
 * What makes a waiting word run something else: a function named for
 * one, as `sleep () { ...; }`, or the places a program is looked up or
 * loaded from changed.
 */
const REDEFINED =
	/[^\s;&|()<>$]\s*\(\s*\)|(?<![\w${])(?:PATH|BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|RIPGREP_CONFIG_PATH|GREP_OPTIONS)(?!\w)/;

/** A separator a step starts after, or the start of the command. */
const STARTS = /(?:^|[\s;&|!])/.source;

/** A `[` or `]` standing as a word of the `[ ... ]` test. */
const TEST_BRACKETS = /(^|[\s;&|!])\[(?=\s)|(\s)\](?=$|[\s;&|])/g;

/** A loop's or a read's target bash may treat as special. */
const SPECIAL_TARGET = new RegExp(
	STARTS +
		/(?:for\s+(?![a-z_][a-z0-9_]*(?:\s|;|$))|read(?:[ \t]+[^\s;&|<>]+)*?[ \t]+[^\s;&|<>]*[A-Z])/
			.source,
);

/**
 * An assignment, prefix or export included, to a name not all
 * lowercase, since bash reads a value given to `RANDOM`, `OPTIND`,
 * `HISTCMD` or `SRANDOM` as arithmetic (8855BD77 [0505f128]).
 */
const SPECIAL_ASSIGNMENT = new RegExp(
	STARTS + /(?![a-z_][a-z0-9_]*\+?=)[A-Za-z_]\w*\+?=/.source,
);

/** A function's keyword, as a word of its own. */
const FUNCTION = new RegExp(STARTS + /function(?:\s|$)/.source);

/** A test's `-o` or `-a`, or any option to printf. */
const OPERANDS = new RegExp(
	STARTS + /(?:(?:test|\[)\s[^;&|\n]*\s-[oa](?=\s|$)|printf\s+-)/.source,
);

/**
 * Whether `command` keeps to the narrow alphabet a wait is read in
 * (1OGSE7 [0b564125]), past which no reader is trusted to follow bash:
 * printable ASCII and space, tab and newline, since bash splits words
 * on fewer blanks than a reader's `\s`; no backslash, which may join a
 * line to hide `$(`; no backquote; `[` and `]` only as the words of a
 * `[ ... ]` test; no single-quoted `$(` another command may evaluate;
 * no function, nor `(` outside a `$(`; a loop's, a read's or an
 * assignment's target a lowercase name, so none is `RANDOM` or
 * `SECONDS`; and no `-o` or
 * `-a` in a test, nor any option to printf, either of which may turn
 * an operand into a name to evaluate. No `#` either, `$#` included, so
 * no comment's apostrophe pairs with a later one to hide the lines
 * between (8855BD77 [8bc84288], 1OGSE7 [0352bfb2]). Giving up a wait
 * only delays a carry, while a wrong one may stop a write.
 */
function inAlphabet(command: string): boolean {
	if (/[^\x20-\x7e\t\n]|[\\`#]/.test(command)) return false;
	if (/[[\]]/.test(command.replace(TEST_BRACKETS, "$1$2 "))) return false;
	const quotes = /"[^"]*"|'[^']*'/g;
	for (const [quote] of command.matchAll(quotes)) {
		if (quote.startsWith("'") && quote.includes("$(")) return false;
	}
	// Read with each quote's words emptied, so a `;` in one ends no step.
	const bare = command.replace(quotes, '""');
	if (/\(/.test(bare.replace(/\$\(\(?/g, ""))) return false;
	return !(
		FUNCTION.test(bare) ||
		SPECIAL_TARGET.test(bare) ||
		SPECIAL_ASSIGNMENT.test(bare) ||
		OPERANDS.test(bare)
	);
}

/**
 * Whether `command` only waits and reads: every step, and every `$(...)`
 * inside one, starts with a word of {@link WAITS} (systemctl only to read
 * a unit's state), past the shell's keywords, assignments and a time
 * limit, in no form of {@link WRITES}; nothing is redirected but to
 * /dev/null or another stream; nothing runs behind `&`; no backquote,
 * heredoc, process substitution or quoted option hides what runs; no
 * function or changed `PATH` makes a waiting word run another program.
 * An empty command waits on nothing, so it is not a wait.
 */
export function onlyWaits(command: string): boolean {
	if (!inAlphabet(command)) return false;
	// A process substitution runs its own command. A quoted option is
	// blanked below, so what it asks can't be read; nor can ANSI-C
	// quoting, whose escapes may hide a word.
	// So do a `${...}` and a `=~` regex, whose grammar is read no further.
	if (/[`]|<<|[<>]\(|\$'|\$\{|=~|(?:^|\s)["'\\]+-/.test(command)) {
		return false;
	}
	// Past a long option's `=` is its value, which names no option; in a
	// short one's word a quote may hide a letter, as `-u's'` does.
	const hidden = (word: string) =>
		/^-\S*["'\\]/.test(word) && !/^--[\w-]+=/.test(word);
	// Read past each substitution, which is judged on its own, so
	// `"$(tail -1)"` hides no option.
	const lifted = substituted(command);
	if (lifted === undefined || lifted.split(/\s+/).some(hidden)) {
		return false;
	}
	// Read with its quotes and backslashes out too, since `read P''ATH`
	// sets PATH (ISXEG8).
	if (
		[command, command.replace(/["'\\]/g, "")].some((one) => REDEFINED.test(one))
	) {
		return false;
	}
	const quoted = blanked(lifted);
	if (quoted === undefined) return false;
	const rest = quoted.replace(ARITHMETIC, "0");
	if (EVALUATED.test(rest)) return false;
	// Read whole, since its steps split at a `&&` or `||` inside it, with
	// each word still quoted standing for what it may expand to, so a
	// `]]` inside one ends no test.
	const tests = rest.replace(/"(?:[^"\\]|\\[\s\S])*"/g, '"$_"');
	for (const test of tests.matchAll(DOUBLE_TEST)) {
		const words = (test[1] ?? "")
			.split(/\s+|&&|\|\||[!()]/)
			.filter((word) => word !== "");
		if (EVALUATES["[["]?.(words)) return false;
	}
	// Only arithmetic that isn't on numbers alone is left.
	if (/\$\(/.test(rest)) return false;
	return stepsWait(
		rest.replace(/"(?:[^"\\]|\\[\s\S])*"|([${])/g, (match, bare) =>
			bare ? `${bare}~` : match,
		),
	);
}

/**
 * Whether `label`, a background job's, reads whole as a wait: one cut
 * short, ending `...`, could hide anything past where it was cut.
 */
export function wholeWait(label: string): boolean {
	return !label.endsWith("...") && onlyWaits(label);
}

/**
 * A quoted word a `$(...)` may hold: a variable's value, or a word with
 * nothing in it that could end the substitution, start a comment or
 * expand, so `"$(jq -r .state "$f")"` reads as plainly as it runs.
 */
const PLAIN_QUOTED = /"\$[A-Za-z_]\w*"|"[^"'$`\\(){}#]*"|'[^"'$`\\(){}#]*'/y;

/**
 * `command` with each `$(...)` in it made `$X` once what it runs only
 * waits. Every round of the 23 November council found another corner of
 * bash's grammar a reader got wrong, each letting a write through, so
 * only a narrow grammar is read (1OGSE7, cf8ef54f): undefined, so the
 * command claims, for a `#` but one after a space outside any quote or
 * substitution, which starts a comment, and for a substitution left
 * open or holding a backslash, a `#`, a `case` or a quote but
 * {@link PLAIN_QUOTED}. `$((` is left for {@link ARITHMETIC}.
 */
function substituted(command: string): string | undefined {
	let out = "";
	let quoted = false;
	for (let at = 0; at < command.length; ) {
		const char = command[at] ?? "";
		let next = at + 1;
		if (char === "\\") next = at + 2;
		else if (char === '"') quoted = !quoted;
		else if (!quoted && char === "'") {
			next = command.indexOf("'", at + 1) + 1;
			if (next === 0 || command.slice(at, next).includes("#")) {
				return undefined;
			}
		} else if (char === "#") {
			if (quoted || !(at === 0 || /\s/.test(command[at - 1] ?? ""))) {
				return undefined;
			}
			const end = command.indexOf("\n", at);
			next = end < 0 ? command.length : end;
		} else if (
			char === "$" &&
			command.startsWith("(", at + 1) &&
			!command.startsWith("(", at + 2)
		) {
			const end = closing(command, at + 2);
			if (end === undefined) return undefined;
			const body = command.slice(at + 2, end);
			if (/(?:^|[\s;&|(])case\b/.test(body) || !onlyWaits(body)) {
				return undefined;
			}
			// Still a substitution, so a word it makes reads as unreadable.
			out += "$X";
			at = end + 1;
			continue;
		}
		out += command.slice(at, next);
		at = next;
	}
	return quoted ? undefined : out;
}

/**
 * Where the `$(...)` whose command starts at `from` in `text` ends, at
 * its `)`; undefined where it doesn't, or holds what
 * {@link substituted} won't read.
 */
function closing(text: string, from: number): number | undefined {
	let depth = 0;
	for (let at = from; at < text.length; at++) {
		const char = text[at] ?? "";
		if ("\\#".includes(char)) return undefined;
		if (char === '"' || char === "'") {
			PLAIN_QUOTED.lastIndex = at;
			if (!PLAIN_QUOTED.test(text)) return undefined;
			at = PLAIN_QUOTED.lastIndex - 1;
		} else if (char === "$" && text[at + 1] === "(") {
			const end = closing(text, at + 2);
			if (end === undefined) return undefined;
			at = end;
		} else if (char === "(") depth++;
		else if (char === ")") {
			if (depth === 0) return at;
			depth--;
		}
	}
	return undefined;
}

/**
 * `command` with each quoted word that expands nothing (single-quoted,
 * or double-quoted with no `$`, backquote or backslash) made one plain
 * word of what it holds after an `@`, each character that would split a
 * step, end a `[[` or pair as a quote made `_`, but a glob or a `[`,
 * which a read into a subscript names, kept, its escapes made plain and its comments taken out, read in the
 * shell's own order, so an apostrophe inside double quotes, escaped or
 * in a comment never pairs with a later quote and blanks the real steps
 * between them (the 23 November council). A quoted word stays a word,
 * so `uniq 'in' out` still counts the file it writes, and one with a
 * space, as `--since "10 min ago"`, reads as plainly as it runs.
 * Undefined where a quote pairs with none.
 */
function blanked(command: string): string | undefined {
	let unpaired = false;
	const plain = command.replace(
		QUOTING,
		(match: string, before: string | undefined) => {
			if (before !== undefined) return before;
			if (match === "'" || match === '"') unpaired = true;
			if (match.startsWith("'") || /^"[^$`\\]*"$/.test(match)) {
				// Marked by an `@`, so a word a quote is in is never read as an
				// assignment: bash runs `P''ATH=/x` as a program (ISXEG8).
				const held = match.slice(1, -1).replace(/[^\w.,:+%/=@[*?-]/g, "_");
				return `'@${held}'`;
			}
			// Still a backslash, so a word it was in reads as unreadable, but
			// no quote or separator, which it took as its own.
			if (match.startsWith("\\")) return "\\_";
			return match;
		},
	);
	return unpaired ? undefined : plain;
}

/** Whether every step of `command` waits or reads, and one runs. */
function stepsWait(command: string): boolean {
	let runs = false;
	for (const step of shellSteps(command)) {
		const bare = bareOf(step);
		if (bare === undefined) return false;
		if (bare === "") continue;
		if (!startsWithWait(bare)) return false;
		runs = true;
	}
	return runs;
}

/**
 * A step's command, past what runs nothing around it; undefined where
 * the step writes somewhere or runs something behind `&`.
 */
function bareOf(step: string): string | undefined {
	let bare = step.trim();
	for (const target of bare.matchAll(REDIRECT)) {
		if (!HARMLESS.test(target[1] ?? "")) return undefined;
	}
	if (/&/.test(bare.replace(REDIRECT, ""))) return undefined;
	bare = bare.replace(REDIRECT, "").trim();
	for (let before = ""; before !== bare; ) {
		before = bare;
		bare = bare
			.replace(KEYWORD, "")
			.replace(ASSIGNMENT, "")
			.replace(UNDER, "")
			.replace(/\s*[)}]+$/, "")
			.trim();
	}
	return FOR.test(bare) ? "" : bare;
}

/** Whether a command starts with a word that only waits or reads. */
function startsWithWait(bare: string): boolean {
	const [first, ...rest] = bare.split(/\s+/);
	if (first === "systemctl") {
		const at = rest.findIndex((word) => !word.startsWith("-"));
		return (
			at >= 0 &&
			SYSTEMCTL_READS.has(rest[at] ?? "") &&
			rest.slice(0, at).every((word) => SYSTEMCTL_FLAGS.test(word))
		);
	}
	if (first === undefined || !WAITS.has(first)) return false;
	if (EVALUATES[first]?.(rest)) return false;
	const writes = WRITES[first];
	if (writes === undefined) return true;
	return !(rest.some((word) => UNREADABLE.test(word)) || writes(rest));
}
