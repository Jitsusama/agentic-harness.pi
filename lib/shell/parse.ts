/**
 * Shell-level command parsing: flag extraction, heredoc
 * stripping, quoting and compound command splitting.
 *
 * These utilities work on raw bash command strings. They know
 * about shell syntax (quoting, heredocs, separators) but
 * nothing about specific CLI tools.
 */

/** A single heredoc found in a command. */
export interface HeredocMatch {
	/** The delimiter word (e.g. `EOF`). */
	readonly delim: string;
	/** The body between the opening line and the closing delimiter. */
	readonly body: string;
	/** Whether the delimiter was quoted (`<<'EOF'`) or bare (`<<EOF`). */
	readonly quoted: boolean;
	/**
	 * The opener-line tokens after the delimiter (a `2>&1 | tail -5`
	 * redirect-and-pipe, say). Empty when nothing trails the
	 * delimiter. The body starts on the next line regardless, so
	 * these are command structure, not body, and a rebuild must
	 * reattach them to the opener line or they vanish.
	 */
	readonly openerRest: string;
	/** Start offset of the whole heredoc within the command. */
	readonly index: number;
	/** Length of the whole heredoc match. */
	readonly length: number;
}

/**
 * Find every heredoc in a command, in order.
 *
 * One primitive backs all heredoc handling so the four call
 * sites cannot drift apart again (the `m`-flag bug in commit
 * `9be69db` was exactly that drift). The closing delimiter must
 * sit on its own line with only trailing horizontal whitespace,
 * so a delimiter word appearing inside the body is not mistaken
 * for the end.
 */
export function matchHeredocs(command: string): HeredocMatch[] {
	// Group 1: optional quote around the delimiter. Group 2: the
	// delimiter word. Group 3: the opener-line tokens after the
	// delimiter (a redirect or pipe). Group 4: the body. The
	// opener accepts anything up to the newline (`[^\n]*`) so a
	// piped `gh ... <<'EOF' 2>&1 | tail -5` still parses; without
	// it the gate, attribution and the unquoted-heredoc guard all
	// go blind on the same command. The closing delimiter is
	// matched via a backreference to group 2 and must sit on its
	// own line (`\n\2`) with only trailing horizontal whitespace
	// before the line end, anchored by `$` under `/m`.
	const HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n([\s\S]*?)\n\2[ \t]*$/gm;
	const matches: HeredocMatch[] = [];
	for (const match of command.matchAll(HEREDOC)) {
		if (match.index === undefined) continue;
		matches.push({
			delim: match[2] ?? "",
			body: match[4] ?? "",
			quoted: match[1] !== "",
			openerRest: match[3] ?? "",
			index: match.index,
			length: match[0].length,
		});
	}
	return matches;
}

/** Extract a --flag value from a command string (quoted or unquoted). */
export function extractFlag(command: string, flag: string): string | null {
	// Double-quoted: --flag "value with spaces"
	const dq = new RegExp(`--${flag}\\s+"((?:[^"\\\\]|\\\\.)*)"`);
	const dqMatch = command.match(dq);
	if (dqMatch) return dqMatch[1]?.replace(/\\(.)/g, "$1") ?? null;

	// Single-quoted: --flag 'value' or --flag 'it'\''s here'
	// Shell has no escape inside single quotes. The idiom '\'' closes
	// the current quote, emits an escaped quote, and opens a new one.
	// The regex matches the full shell value including '\'' sequences,
	// then post-processing strips outer quotes and unescapes.
	const sq = new RegExp(`--${flag}\\s+('[^']*(?:'\\\\''[^']*)*')`);
	const sqMatch = command.match(sq);
	if (sqMatch?.[1]) {
		return sqMatch[1].slice(1, -1).replace(/'\\''/g, "'");
	}

	// Unquoted: --flag value (no whitespace in value)
	const uq = new RegExp(`--${flag}\\s+(\\S+)`);
	const uqMatch = command.match(uq);
	return uqMatch?.[1] ?? null;
}

/** Extract the body from a command, supporting heredoc and --body flag. */
export function extractBody(
	fullCommand: string,
	entityPart: string,
): string | null {
	// Heredoc: --body-file - <<'DELIM'\nbody\nDELIM
	const heredoc = matchHeredocs(fullCommand)[0];
	if (heredoc) return heredoc.body;

	// --body flag
	return extractFlag(entityPart, "body");
}

/** Safe shell quoting. */
export function quote(s: string): string {
	if (!s.includes("'")) return `'${s}'`;
	return `"${s.replace(/["\\]/g, "\\$&")}"`;
}

/**
 * Split a compound command at the last separator before the
 * target command. Returns the prefix (everything before) and
 * the target command portion.
 *
 * Separators: `&&`, `;`, and newlines. Newlines are statement
 * separators in shell scripts, just like `;`. Without this,
 * guardians silently drop prefixes when the agent formats
 * commands across multiple lines.
 *
 * Examples:
 *   splitAtCommand("cd /path && gh pr create ...", /gh\s+pr\s+.../)
 *   splitAtCommand("git add -A && git commit ...", /git\s+commit\b/)
 *   splitAtCommand("git checkout branch\ngh pr create ...", /gh\s+pr\s+.../)
 */
export function splitAtCommand(
	command: string,
	targetPattern: RegExp,
): { prefix: string | null; target: string } {
	const source = targetPattern.source;
	// [\s\S]* for the prefix so it matches across newlines.
	// Separators: &&, ;, or newline.
	const re = new RegExp(
		`^([\\s\\S]*)\\s*(?:&&|;|\\n)\\s*(${source}[\\s\\S]*)$`,
	);
	const match = command.match(re);
	if (match?.[1]?.trim()) {
		return { prefix: match[1].trim(), target: match[2] ?? command };
	}
	return { prefix: null, target: command };
}

/**
 * Strip heredoc bodies from a command so only actual shell
 * commands are analysed. Without this, text inside a heredoc
 * (like "git commit" in a PR description) would be mistaken
 * for a real command.
 */
export function stripHeredocBodies(command: string): string {
	// Remove each heredoc span (operator through closing delimiter)
	// from the end backwards so earlier offsets stay valid.
	let result = command;
	for (const heredoc of matchHeredocs(command).reverse()) {
		result =
			result.slice(0, heredoc.index) +
			result.slice(heredoc.index + heredoc.length);
	}
	return result;
}

/**
 * Check whether a command contains a heredoc with an unquoted
 * delimiter. Unquoted delimiters (`<<EOF`) allow shell variable
 * expansion inside the body, which almost always corrupts the
 * content. Quoted delimiters (`<<'EOF'` or `<<"EOF"`) suppress
 * expansion and pass content through literally.
 *
 * Matches the full heredoc structure (operator, body and
 * closing delimiter) so that `<<` appearing inside heredoc
 * body text does not trigger false positives.
 *
 * Returns true if an unquoted heredoc is found. Returns false
 * if there are no heredocs or all heredocs have quoted
 * delimiters.
 */
export function hasUnquotedHeredoc(command: string): boolean {
	return matchHeredocs(command).some((heredoc) => !heredoc.quoted);
}

/**
 * Check whether a `--body-file` flag points to a file path
 * instead of stdin (`-`). Returns the path if found, null
 * if `--body-file -` or no `--body-file` at all.
 */
export function extractBodyFilePath(command: string): string | null {
	const match = command.match(/--body-file\s+(\S+)/);
	if (!match) return null;
	const target = match[1];
	if (target === "-") return null;
	// Strip surrounding quotes if present.
	return target?.replace(/^['"]|['"]$/g, "") ?? null;
}

/** Characters that delimit commands in shell syntax. */
const COMMAND_DELIMITERS = new Set([";", "&", "|", "(", ")"]);

/**
 * Strip non-executable content from a shell command string:
 * comments and the interior of quoted strings.
 *
 * Designed to run on the output of `stripHeredocBodies` so
 * that heredoc bodies are already removed. The result is a
 * command skeleton suitable for pattern matching — command
 * names, flags and operators survive; data does not.
 *
 * The scanner tracks single-quote, double-quote and escape
 * state across the entire string (including newlines) so
 * multi-line quoted strings are handled correctly.
 *
 * Backslash-newline (line continuation) is handled correctly:
 * both characters are consumed and the next line continues
 * mid-word, so a `#` after a continuation is not mistaken
 * for a comment.
 *
 * Quote delimiters themselves are preserved (content between
 * them is removed) so that surrounding syntax stays intact:
 *   `git commit -m "message" --no-verify`
 *   → `git commit -m "" --no-verify`
 */
export function stripShellData(command: string): string {
	let result = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	// Tracks whether the current position could start a new
	// token. Maintained by the scanner so that backslash-newline
	// continuations correctly suppress word-start detection.
	let atWordStart = true;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		// The previous character was an unquoted backslash, so
		// this character is escaped.
		if (escaped) {
			escaped = false;
			// Backslash-newline is a line continuation: both
			// characters are consumed and the lines join. The
			// next character is still mid-word.
			if (ch === "\n") continue;
			if (!inSingle && !inDouble) {
				result += "\\";
				result += ch;
			}
			atWordStart = false;
			continue;
		}

		// Backslash escapes the next character in every context
		// except single quotes, where nothing is special.
		if (ch === "\\" && !inSingle) {
			escaped = true;
			atWordStart = false;
			continue;
		}

		// Single-quote toggle (only outside double quotes).
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			result += ch;
			atWordStart = false;
			continue;
		}

		// Double-quote toggle (only outside single quotes).
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			result += ch;
			atWordStart = false;
			continue;
		}

		// Inside quotes: swallow the content.
		if (inSingle || inDouble) continue;

		// Unquoted `#` at a word-start position begins a comment
		// that runs to the end of the line.
		if (ch === "#" && atWordStart) {
			const newline = command.indexOf("\n", i);
			if (newline === -1) break;
			// We jump to the character before the newline so the
			// loop increment lands on the newline itself, which
			// the next iteration emits normally.
			i = newline - 1;
			continue;
		}

		result += ch;
		atWordStart = ch === "\n" || /\s/.test(ch) || COMMAND_DELIMITERS.has(ch);
	}

	// A trailing backslash with no following character: emit it
	// so the command skeleton reflects the original structure.
	if (escaped && !inSingle && !inDouble) {
		result += "\\";
	}

	return result;
}
