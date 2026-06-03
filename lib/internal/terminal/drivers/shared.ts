/**
 * Shared helpers for terminal drivers.
 *
 * Drivers that hand the command to a multiplexer daemon
 * (wezterm cli, tmux) cannot pass environment variables
 * through Node's child_process env: the daemon runs the
 * pane in its own environment. Wrapping the command in a
 * shell that sets the env vars and execs the original
 * command is the portable way to ship per-spawn env.
 *
 * Drivers that spawn the process directly (the fallback's
 * future direct-shell mode, for example) can use Node's
 * env passthrough and skip the wrap.
 */

/**
 * POSIX-shell-quote a single string. Wraps in single
 * quotes and escapes any embedded single quotes.
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Wrap a command so the given env vars are visible to it.
 * Returns the original command unchanged when no env vars
 * are supplied.
 *
 * The wrap is `KEY=value... exec sh -c '<command>'` rather
 * than `KEY=value... exec <command>`: the assignment
 * prefix and `exec` only consume the next single token, so
 * a compound `<command>` like `echo hi; sleep 30` would
 * lose everything after the first token. Wrapping in
 * `sh -c` makes the whole thing a single token from the
 * outer shell's point of view and lets shell metacharacters
 * inside `<command>` keep their normal meaning.
 *
 * `exec` keeps the process tree shallow: the outer shell
 * is replaced by the inner sh, which then runs the user's
 * command, so signals and pid resolution behave as if the
 * command ran one level deeper than a plain `sh -c`.
 */
export function wrapCommandWithEnv(
	command: string,
	env: Readonly<Record<string, string>> | undefined,
): string {
	if (!env) return command;
	const entries = Object.entries(env);
	if (entries.length === 0) return command;
	const assignments = entries
		.map(([k, v]) => `${k}=${shellQuote(v)}`)
		.join(" ");
	return `${assignments} exec sh -c ${shellQuote(command)}`;
}
