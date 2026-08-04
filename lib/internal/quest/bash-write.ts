/**
 * Advisory classification of a bash command for the quest phase
 * gate. The command is reduced to its executable skeleton first
 * (heredoc bodies and quoted data removed) so a mutating verb that
 * appears only as a literal argument, or inside a heredoc body,
 * does not trip the gate. This is a nudge toward the right stage,
 * not a security boundary.
 */

import { tokenize, type Word } from "../../command/index.js";
import {
	stripHeredocBodies,
	stripShellData,
	unquote,
} from "../../shell/index.js";

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
export function bashWriteTargets(command: string): string[] {
	const skeleton = stripShellData(stripHeredocBodies(command));
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

	for (const target of modelledTargets(command)) add(target);

	return [...new Set(targets)];
}

/**
 * Write destinations read from the command model, where quoting is
 * already understood.
 *
 * Three shapes, the same three the patterns above look for: a redirect's
 * target, `tee`'s file arguments, and the file arguments of an in-place
 * editor. A file-descriptor redirect (`2>`, `&>`) is skipped, matching
 * what the pattern pass does, since it routes a stream rather than naming
 * a content target.
 *
 * An editor's script is reported alongside its file, because telling one
 * from the other means knowing whether this `sed` is the BSD or the GNU
 * one. A script cannot name tracked code, so including it costs nothing,
 * whereas missing the file was the whole defect.
 */
function modelledTargets(command: string): string[] {
	const line = tokenize(command);
	const found: string[] = [];

	for (const simple of line.commands) {
		for (const redirect of simple.redirects) {
			if (!redirect.target) continue;
			if (/^[0-9&]/.test(redirect.operator)) continue;
			found.push(unquote(redirect.target.text));
		}

		const argv = simple.argv.map((word) => unquote(word.text));
		const name = argv[0];
		if (!name) continue;
		const rest = argv.slice(1).filter((token) => !token.startsWith("-"));
		if (name === "tee") found.push(...rest);
		if (/^(g?sed|perl)$/.test(name) && editsInPlace(simple.argv)) {
			found.push(...rest);
		}
	}

	return found;
}

/** Whether an editor invocation carries the in-place flag. */
function editsInPlace(argv: Word[]): boolean {
	return argv.some((word) => {
		const text = unquote(word.text);
		return text === "-i" || text.startsWith("-i");
	});
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
	const skeleton = stripShellData(stripHeredocBodies(command));
	if (GIT_MUTATING.test(skeleton)) return "git-mutating";
	if (BASH_WRITE_PATTERNS.some((rx) => rx.test(skeleton))) return "bash-write";
	return "read-only";
}
