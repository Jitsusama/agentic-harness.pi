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
 * Wrap a command in a `/bin/sh -c` that sets the given
 * env vars and execs the command. Returns the original
 * command unchanged when no env vars are supplied. The
 * `exec` keeps the new process tree shallow: the shell
 * is replaced by the user's command, so signals and pid
 * resolution behave as if the command ran directly.
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
	return `${assignments} exec ${command}`;
}
