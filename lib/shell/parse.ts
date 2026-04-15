/**
 * Shell-level command parsing: flag extraction, heredoc
 * stripping, quoting and compound command splitting.
 *
 * These utilities work on raw bash command strings. They know
 * about shell syntax (quoting, heredocs, separators) but
 * nothing about specific CLI tools.
 */

/** Extract a --flag value from a command string (quoted or unquoted). */
export function extractFlag(command: string, flag: string): string | null {
	// Double-quoted: --flag "value with spaces"
	const dq = new RegExp(`--${flag}\\s+"((?:[^"\\\\]|\\\\.)*)"`);
	const dqMatch = command.match(dq);
	if (dqMatch) return dqMatch[1]?.replace(/\\(.)/g, "$1");

	// Single-quoted: --flag 'value with spaces'
	const sq = new RegExp(`--${flag}\\s+'([^']*)'`);
	const sqMatch = command.match(sq);
	if (sqMatch) return sqMatch[1] ?? null;

	// Unquoted: --flag value (no whitespace in value)
	const uq = new RegExp(`--${flag}\\s+(\\S+)`);
	const uqMatch = command.match(uq);
	if (uqMatch) return uqMatch[1] ?? null;

	return null;
}

/** Extract the body from a command, supporting heredoc and --body flag. */
export function extractBody(
	fullCommand: string,
	entityPart: string,
): string | null {
	// Heredoc: --body-file - <<'DELIM'\nbody\nDELIM
	const heredoc = fullCommand.match(
		/<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/,
	);
	if (heredoc) return heredoc[2] ?? null;

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
	return command.replace(
		/<<-?\s*['"]?(\w+)['"]?\s*\n[\s\S]*?\n\1(?:\s*$)?/gm,
		"",
	);
}

/** Characters that delimit commands in shell syntax. */
const COMMAND_DELIMITERS = new Set([";", "&", "|", "(", ")"]);

/**
 * Return true when the character at position `i` could start
 * a new token in shell syntax. A `#` at such a position begins
 * a comment.
 */
function isWordStart(command: string, i: number): boolean {
	if (i === 0) return true;
	const prev = command[i - 1];
	return /\s/.test(prev) || COMMAND_DELIMITERS.has(prev);
}

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

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		// The previous character was an unquoted backslash, so
		// this character is escaped — emit it unconditionally.
		if (escaped) {
			escaped = false;
			if (!inSingle && !inDouble) {
				result += ch;
			}
			continue;
		}

		// Backslash escapes the next character in every context
		// except single quotes, where nothing is special.
		if (ch === "\\" && !inSingle) {
			escaped = true;
			if (!inDouble) {
				result += ch;
			}
			continue;
		}

		// Single-quote toggle (only outside double quotes).
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			result += ch;
			continue;
		}

		// Double-quote toggle (only outside single quotes).
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			result += ch;
			continue;
		}

		// Inside quotes: swallow the content.
		if (inSingle || inDouble) continue;

		// Unquoted `#` at a word-start position begins a comment
		// that runs to the end of the line.
		if (ch === "#" && isWordStart(command, i)) {
			const newline = command.indexOf("\n", i);
			if (newline === -1) break;
			// We jump to the character before the newline so the
			// loop increment lands on the newline itself, which
			// the next iteration emits normally.
			i = newline - 1;
			continue;
		}

		result += ch;
	}

	return result;
}
