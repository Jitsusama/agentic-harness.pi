/**
 * Advisory classification of a bash command for the quest phase
 * gate. The command is reduced to its executable skeleton first
 * (heredoc bodies and quoted data removed) so a mutating verb that
 * appears only as a literal argument, or inside a heredoc body,
 * does not trip the gate. This is a nudge toward the right stage,
 * not a security boundary.
 */

import { isAbsolute, join, resolve } from "node:path";
import { type SimpleCommand, tokenize } from "../../command/index.ts";
import { stripShellData, unquote } from "../../shell/index.ts";
import { matchHeredocs } from "../../shell/parse.ts";
import { createdBy, removedBy, unwrap } from "./bash-effects.ts";

/** What kind of write, if any, a bash command performs. */
export type BashWriteKind = "git-mutating" | "bash-write" | "read-only";

/** Git subcommands that change repository or working-tree state. */
const GIT_MUTATING =
	/\bgit(?:\s+(?:-c\s+\S+|-C\s+\S+|--git-dir=\S+|--work-tree=\S+|--no-pager))*\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|switch|restore|am|format-patch)\b/i;

/** Shell patterns that write to the filesystem via redirection or in-place edit. */
const BASH_WRITE_PATTERNS = [
	/(^|\s|[;&|`])cat\s+[^|]*>>?\s/, // cat > foo, cat >> foo
	/(^|\s|[;&|`])tee\s+(?:-[a-z]+\s+)*\S/, // tee foo, tee -a foo
	/(^|\s|[;&|`])sed\s+(?:-[a-z]+\s+)*-i\b/, // sed -i
	/(^|\s|[;&|`])gsed\s+(?:-[a-z]+\s+)*-i\b/, // homebrew sed
	/(^|\s|[;&|`])perl\s+(?:-[a-z]+\s+)*-i\b/, // perl -i
	/(^|\s|[;&|`])printf\s+.+>>?\s/, // printf > foo
	/(^|\s|[;&|`])echo\s+.+>>?\s/, // echo > foo
];

/**
 * Extract the destination paths a bash command writes to, so the
 * gate can see where the write lands and allow scratch
 * destinations. The command is reduced to the same data-stripped
 * skeleton the classifier matches on, so a redirect that lived
 * inside quoted data raises no phantom target. Three write shapes
 * are read: redirect destinations (`>`, `>>`, excluding fd
 * redirects such as `2>`), `tee` destinations, and the file
 * argument of an in-place editor (sed -i, gsed -i, perl -i), whose
 * quoted script has already been stripped, leaving the file as a
 * trailing non-flag token.
 *
 * A target the command builds out of its own variables is expanded
 * from the assignments in that same command, since `Q=...; echo >
 * "$Q/f"` is one of the commonest ways to write to a directory whose
 * path is long. A target still carrying a sigil after that is dropped
 * rather than reported: the caller resolves what it is given against a
 * working directory, so a literal `$UNKNOWN/f.txt` becomes a real path
 * nobody wrote to, and judging the wrong file is worse than declining
 * to judge this one.
 *
 * A quoted destination counts, which is the ordinary spelling and the
 * spelling a variable almost always arrives in. Reading it does not cost
 * the protection against a `>` inside a string, because the two are
 * different questions: what makes a redirect real is its operator being
 * unquoted, not its target being bare. The command model already draws
 * that line, so the targets come from there and the patterns below stay
 * as a second pass for the grammar it declines, such as a subshell or a
 * loop. Both readings are kept because this gate wants recall: a missed
 * target is an unjudged write, while a spurious one is inert unless it
 * happens to name tracked code.
 */
export function bashWriteTargets(written: string): string[] {
	const command = readable(written);
	const skeleton = stripShellData(command);
	const assigned = assignmentsIn(skeleton, command);
	const targets: string[] = [];
	const add = (token: string | undefined): void => {
		if (!token) return;
		const bare = token.replace(/^['"]/, "").replace(/['"]$/, "");
		if (!bare) return;
		const value = expand(bare, assigned);
		// Anything still holding a `$` was built from something this command
		// does not say, so there is nothing honest to report.
		if (value === undefined) return;
		targets.push(value);
	};

	for (const target of patternTargets(skeleton)) add(target);
	for (const simple of tokenize(command).commands) {
		for (const target of commandTargets(simple)) add(target);
	}

	return [...new Set(targets)];
}

/**
 * Write destinations found by pattern in a data-stripped skeleton, for
 * the grammar the command model declines, such as a loop or a subshell.
 */
function patternTargets(skeleton: string): string[] {
	const found: string[] = [];
	const add = (token: string | undefined): void => {
		if (token) found.push(token);
	};

	// Redirect destinations: the token following > or >>. A leading
	// digit or & marks an fd redirect (2>, &>), which routes a stream
	// rather than naming a content target, so it is skipped.
	// A closing paren is excluded from the target so `(echo x > f.ts)` does
	// not report `f.ts)`, which names nothing and so is never judged. A real
	// filename may hold a paren, but a subshell ending is far likelier, and
	// this pass is the one reading commands the model would not.
	for (const match of skeleton.matchAll(/(?<![0-9&])>>?\s*([^\s;&|<>()]+)/g)) {
		add(match[1]);
	}

	// tee destinations: non-flag tokens following a tee invocation.
	for (const match of skeleton.matchAll(
		/(?:^|[|;&]|\s)tee\s+((?:-[^\s]+\s+)*)(\S+)/g,
	)) {
		add(match[2]);
	}

	// In-place editor file arguments: every non-flag token after the
	// editor invocation. An unquoted script token cannot resolve to
	// a tracked path, so it is harmless to include.
	for (const match of skeleton.matchAll(
		/(?:^|[|;&]|\s)(?:g?sed|perl)\s+([^|;&\n]*)/g,
	)) {
		const tokens = (match[1] ?? "").split(/\s+/).filter(Boolean);
		if (!tokens.some((t) => t === "-i" || t.startsWith("-i"))) continue;
		for (const token of tokens) {
			if (token.startsWith("-")) continue;
			add(token);
		}
	}

	return found;
}

/**
 * A command with what can only mislead a reading of its writes taken
 * out, keeping every offset but the heredocs'.
 *
 * A heredoc's body is data, so it goes, but what its opening line says
 * after the heredoc's word stays: `cat <<EOF > out.txt` writes out.txt,
 * and `cat <<'EOF' | tee -a log.md` writes log.md, while a reading that
 * dropped the whole opener, as removing the heredoc outright did, saw
 * neither.
 *
 * Arithmetic, `$((3 > 2))` and `(( n > 5 ))`, and a `[[ a > b ]]` test
 * are blanked to a word of the same length, since their `>` compares
 * and read as a redirect it named a file called `2`. Blanked rather than
 * removed, so a value assigned from one is still an assignment and a
 * test is still a command.
 */
function readable(command: string): string {
	const blank = (whole: string) => "0".repeat(whole.length);
	let result = command.replace(ARITHMETIC, blank).replace(TEST, blank);
	for (const heredoc of matchHeredocs(result).reverse()) {
		result =
			result.slice(0, heredoc.index) +
			heredoc.openerRest +
			result.slice(heredoc.index + heredoc.length);
	}
	return result;
}

/** `$((...))` or `((...))`, holding parentheses one level deep. */
const ARITHMETIC = /\$?\(\((?:[^()]|\([^()]*\))*\)\)/g;

/** `[[ ... ]]`, whose brackets stand apart from what they test. */
const TEST = /\[\[\s(?:[^\]]|\](?!\]))*\s\]\]/g;

/** Where a command runs: the session directory and the home `~` names. */
export interface CommandPlace {
	readonly cwd: string;
	readonly home: string;
}

/** The places a bash command writes to, split by whether they are known. */
export interface ResolvedWrites {
	/** Absolute paths the command writes to. */
	readonly paths: string[];
	/** Absolute paths the command removes. */
	readonly removed: string[];
	/** Targets it writes to whose location the command does not say. */
	readonly unresolved: string[];
}

/**
 * Resolve where a bash command writes, in the directory each writing
 * command actually runs in.
 *
 * The session directory is only where the command starts: `cd <tree> &&
 * cat >> x_test.go` writes inside the tree, and reading it against the
 * session directory is how a write in a tracked tree came to be judged as
 * one in the repository the session happened to open. So the command
 * model is walked in order, each `cd` moving the directory for what
 * follows, with the command's own variables filled in.
 *
 * A target whose location the command does not say is reported as
 * unresolved rather than guessed: a `cd` into a command substitution, a
 * variable from outside the command, or a relative target in a subshell
 * or loop that changes directory. A guess judges a file nobody wrote,
 * while an unresolved target can still be checked on disk afterwards.
 *
 * What a command removes is placed the same way and kept apart, since
 * removing a document is a different question from writing one. It is
 * only read where the command model applies; a removal inside a loop or
 * a subshell is left to the check on disk.
 */
export function resolveBashWrites(
	written: string,
	place: CommandPlace,
): ResolvedWrites {
	const command = readable(written);
	const skeleton = stripShellData(command);
	const known = assignmentsIn(skeleton, command);
	const paths: string[] = [];
	const removed: string[] = [];
	const unresolved: string[] = [];
	const locate = (
		raw: string,
		dir: string | undefined,
		into: string[] = paths,
	): void => {
		const bare = raw.replace(/^['"]/, "").replace(/['"]$/, "");
		if (!bare) return;
		const value = expand(bare, known);
		const absolute =
			value === undefined ? undefined : absoluteIn(value, dir, place.home);
		if (absolute === undefined) unresolved.push(value ?? bare);
		else into.push(absolute);
	};

	const line = tokenize(command);
	if (line.supported) {
		let dir: string | undefined = place.cwd;
		for (const simple of line.commands) {
			const argv = argvOf(simple);
			if (argv[0] === "cd") {
				dir = changeDirectory(dir, argv[1], known, place.home);
				continue;
			}
			for (const target of commandTargets(simple)) locate(target, dir);
			for (const target of removedBy(unwrap(argv))) {
				locate(target, dir, removed);
			}
		}
	} else {
		// Outside the grammar there is no order to follow, so a relative
		// target is only placed when nothing in the command changes directory.
		const moves = /(?:^|[\s;&|(])cd(?:\s|$)/.test(skeleton);
		for (const target of patternTargets(skeleton)) {
			locate(target, moves ? undefined : place.cwd);
		}
	}

	return {
		paths: [...new Set(paths)],
		removed: [...new Set(removed)],
		unresolved: [...new Set(unresolved)],
	};
}

/**
 * The directory after `cd <target>`, or undefined once it is no longer
 * knowable: `cd -`, or a target the command's own variables cannot fill.
 */
function changeDirectory(
	dir: string | undefined,
	target: string | undefined,
	known: Map<string, string>,
	home: string,
): string | undefined {
	if (target === undefined) return home;
	if (target === "-") return undefined;
	const value = expand(target, known);
	return value === undefined ? undefined : absoluteIn(value, dir, home);
}

/** A path made absolute, or undefined when it is relative to nothing known. */
function absoluteIn(
	path: string,
	dir: string | undefined,
	home: string,
): string | undefined {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	if (isAbsolute(path)) return resolve(path);
	return dir === undefined ? undefined : resolve(dir, path);
}

/**
 * One command's write destinations, read from the command model, where
 * quoting is already understood.
 *
 * The three shapes `patternTargets` also looks for, a redirect's target,
 * `tee`'s file arguments and the file arguments of an in-place editor,
 * plus what a command creates without a redirect (see `createdBy`), read
 * through wrappers such as `nohup` and `env`. A file-descriptor redirect
 * (`2>`, `&>`) is skipped, matching what the pattern pass does, since it
 * routes a stream rather than naming a content target. An input redirect
 * (`<`) is skipped too: it names a file the command reads, and counting
 * it as a write refused plain reads such as `wc -c < notes.md` in build.
 *
 * An editor's script is told apart from its files by reading its options
 * the way the editor does, since a script reported as a file is a path
 * nobody wrote, and one that happens to look like a quest document gets
 * a write refused that never touched it.
 */
function commandTargets(simple: SimpleCommand): string[] {
	const found: string[] = [];

	for (const redirect of simple.redirects) {
		if (!redirect.target) continue;
		if (/^[0-9&]/.test(redirect.operator)) continue;
		if (!redirect.operator.includes(">")) continue;
		found.push(unquote(redirect.target.text));
	}

	const argv = unwrap(argvOf(simple));
	const name = argv[0];
	if (!name) return found;
	found.push(...createdBy(argv));
	if (name === "tee") {
		found.push(...argv.slice(1).filter((token) => !token.startsWith("-")));
	}
	if (/^g?sed$/.test(name)) found.push(...sedFiles(argv.slice(1)));
	if (name === "perl") found.push(...perlFiles(argv.slice(1)));

	return found;
}

/** Short sed options that take the next word as their value. */
const SED_VALUED = new Set(["e", "f", "l"]);

/**
 * The files a sed invocation edits in place, or none when it does not.
 *
 * Both spellings of the in-place flag are read. GNU attaches its optional
 * suffix (`-i.bak`); BSD always takes one as the next word, and that word
 * is only read as a suffix when it looks like one (empty, or starting with
 * a dot), since `sed -i 's/a/b/' f` is the GNU spelling written on a Mac.
 * Without `-e` or `-f`, the first operand is the script.
 */
function sedFiles(args: string[]): string[] {
	const operands: string[] = [];
	let inPlace = false;
	let scripted = false;
	for (let at = 0; at < args.length; at++) {
		const arg = args[at] ?? "";
		if (arg === "--") {
			operands.push(...args.slice(at + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const [option] = arg.split("=", 1);
			if (option === "--in-place") inPlace = true;
			if (option === "--expression" || option === "--file") {
				scripted = true;
				if (!arg.includes("=")) at++;
			}
			continue;
		}
		if (!arg.startsWith("-") || arg === "-") {
			operands.push(arg);
			continue;
		}
		for (let char = 1; char < arg.length; char++) {
			const flag = arg[char] ?? "";
			if (flag === "i") {
				inPlace = true;
				const next = args[at + 1];
				const bare = char === arg.length - 1;
				if (bare && next !== undefined && /^(\.|$)/.test(next)) at++;
				break;
			}
			if (SED_VALUED.has(flag)) {
				if (flag !== "l") scripted = true;
				if (char === arg.length - 1) at++;
				break;
			}
		}
	}
	if (!inPlace) return [];
	return scripted ? operands : operands.slice(1);
}

/** Perl switches whose value is the rest of the word, or the next word. */
const PERL_VALUED = new Set(["e", "E", "I", "M", "m", "x"]);

/** Perl switches whose optional value can only be attached. */
const PERL_ATTACHED = new Set(["i", "l", "0", "C", "d", "D", "F"]);

/**
 * The files a perl invocation edits in place, or none when it does not.
 *
 * Switches cluster (`-pi`, `-ne`), so each word is read one switch at a
 * time. Without `-e` or `-E`, the first operand is the program file.
 */
function perlFiles(args: string[]): string[] {
	const operands: string[] = [];
	let inPlace = false;
	let inline = false;
	for (let at = 0; at < args.length; at++) {
		const arg = args[at] ?? "";
		if (arg === "--") {
			operands.push(...args.slice(at + 1));
			break;
		}
		if (!arg.startsWith("-") || arg === "-") {
			operands.push(...args.slice(at));
			break;
		}
		for (let char = 1; char < arg.length; char++) {
			const flag = arg[char] ?? "";
			if (flag === "i") inPlace = true;
			if (PERL_VALUED.has(flag)) {
				if (flag === "e" || flag === "E") inline = true;
				if (char === arg.length - 1) at++;
				break;
			}
			if (PERL_ATTACHED.has(flag)) break;
		}
	}
	if (!inPlace) return [];
	return inline ? operands : operands.slice(1);
}

/** A command's arguments as the command receives them: braces expanded, quotes removed. */
function argvOf(simple: SimpleCommand): string[] {
	return simple.argv.flatMap((word) => expandBraces(word.text).map(unquote));
}

/**
 * A word with its brace lists expanded, the way bash does before a
 * command sees its arguments: `lab/{a,b}` is `lab/a lab/b`.
 *
 * Only an unquoted list with a comma at its top level expands, so
 * `'{a,b}'`, `{solo}` and a variable's `${NAME}` stay as written. A
 * sequence such as `{1..3}` is left alone too; nothing that writes into a
 * quest folder has been seen to use one.
 */
function expandBraces(word: string): string[] {
	for (let open = 0; open < word.length; open = skipQuoted(word, open) + 1) {
		if (word[open] !== "{" || word[open - 1] === "$") continue;
		const list = braceList(word, open);
		if (!list) continue;
		const prefix = word.slice(0, open);
		const suffix = word.slice(list.close + 1);
		return list.parts.flatMap((part) => expandBraces(prefix + part + suffix));
	}
	return [word];
}

/**
 * The alternatives of the brace list opening at `open`, and where it
 * closes, or undefined when the braces hold no top-level comma or never
 * close.
 */
function braceList(
	word: string,
	open: number,
): { parts: string[]; close: number } | undefined {
	const parts: string[] = [];
	let depth = 0;
	let start = open + 1;
	for (let at = open; at < word.length; at = skipQuoted(word, at) + 1) {
		const char = word[at];
		if (char === "{") depth++;
		else if (char === "}" && --depth === 0) {
			if (parts.length === 0) return undefined;
			parts.push(word.slice(start, at));
			return { parts, close: at };
		} else if (char === "," && depth === 1) {
			parts.push(word.slice(start, at));
			start = at + 1;
		}
	}
	return undefined;
}

/**
 * The last index of the quoted span or escape starting at `at`, or `at`
 * itself when nothing starts there, so a scan can step past quoted text.
 */
function skipQuoted(word: string, at: number): number {
	const char = word[at];
	if (char === "\\") return at + 1;
	if (char !== "'" && char !== '"') return at;
	let end = at + 1;
	while (end < word.length && word[end] !== char) {
		if (char === '"' && word[end] === "\\") end++;
		end++;
	}
	return end;
}

/**
 * The variables a command assigns to itself, last assignment winning.
 *
 * Only the literal `NAME=value` form, which is what a command writing to
 * a long path actually uses. A value built from an earlier variable is
 * expanded against what is known so far, so `A=/tmp; B=$A/x` resolves.
 */
function assignmentsIn(skeleton: string, command: string): Map<string, string> {
	const known = new Map<string, string>();
	const record = (name: string | undefined, raw: string): void => {
		if (!name) return;
		const value = expand(unquote(raw), known);
		if (value !== undefined) known.set(name, value);
	};

	// The model first, because it keeps a quoted value. `Q="/tmp/q"` reaches
	// the skeleton as `Q=""`, so reading only that lost exactly the paths
	// long enough to be worth a variable.
	for (const simple of tokenize(command).commands) {
		for (const word of simple.assignments) {
			const at = word.text.indexOf("=");
			if (at < 0) continue;
			record(word.text.slice(0, at), word.text.slice(at + 1));
		}
	}

	for (const match of skeleton.matchAll(
		/(?:^|[;&|]|\s)([A-Za-z_][A-Za-z0-9_]*)=([^\s;&|<>]*)/g,
	)) {
		record(match[1], match[2] ?? "");
	}

	return known;
}

/**
 * A token with its variables filled in, or undefined when one of them is
 * not something this command said.
 *
 * Both spellings, `$NAME` and `${NAME}`. A command substitution is never
 * expanded: what it produces is not knowable from the text.
 */
function expand(token: string, known: Map<string, string>): string | undefined {
	if (!token.includes("$")) return token;
	if (token.includes("$(")) return undefined;
	const filled = token.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
		(whole, braced, bare) => known.get(braced ?? bare) ?? whole,
	);
	return filled.includes("$") ? undefined : filled;
}

/**
 * Classify a bash command after stripping non-executable content,
 * so quoted literals and heredoc bodies cannot raise a false
 * positive.
 */
export function classifyBashWrite(command: string): BashWriteKind {
	const skeleton = stripShellData(readable(command));
	if (GIT_MUTATING.test(skeleton)) return "git-mutating";
	if (BASH_WRITE_PATTERNS.some((rx) => rx.test(skeleton))) return "bash-write";
	return "read-only";
}
