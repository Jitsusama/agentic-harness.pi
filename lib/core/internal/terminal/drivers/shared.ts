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

/** How long typing waits for a new shell to draw its prompt. */
export const PROMPT_WAIT_MS = 5_000;

/** How often the surface is read while waiting. */
const PROMPT_POLL_MS = 100;

/** How long the drawn prompt must stay unchanged to count as settled. */
const PROMPT_QUIET_MS = 200;

/**
 * Wait until a surface shows a settled prompt, as a person would before
 * typing. Text typed into a shell that is still reading its startup
 * files can be swallowed by them: a restore once lost the front of one
 * resume line in three that way, leaving the shell to run only the
 * redirection at its end. Resolves true once the surface shows text
 * that has stopped changing, false when it never does within the wait,
 * so the caller can type anyway and say so.
 */
export async function untilPromptShown(
	read: () => Promise<string>,
	waitMs: number = PROMPT_WAIT_MS,
): Promise<boolean> {
	const deadline = Date.now() + waitMs;
	let last = "";
	let since = 0;
	while (Date.now() < deadline) {
		let text = "";
		try {
			text = (await read()).trim();
		} catch {
			// A surface not yet readable is one not yet ready.
		}
		if (text && text === last) {
			if (Date.now() - since >= PROMPT_QUIET_MS) return true;
		} else {
			last = text;
			since = Date.now();
		}
		await new Promise((resolve) => setTimeout(resolve, PROMPT_POLL_MS));
	}
	return false;
}

/**
 * The line to type into an interactive shell so it runs `command` with
 * `env` set, submitted by its trailing newline.
 *
 * The assignments go in front of the command rather than through
 * `wrapCommandWithEnv`, because the line is read by the person's own
 * shell, which may be zsh, bash or fish, and all three take a
 * `KEY=value command` prefix while only the first two read `exec sh
 * -c` the same way.
 */
export function typedLine(
	command: string,
	env: Readonly<Record<string, string>> | undefined,
): string {
	const assignments = Object.entries(env ?? {})
		.map(([k, v]) => `${k}=${shellQuote(v)} `)
		.join("");
	return `${assignments}${command}\n`;
}

/**
 * Variables a launched terminal must not inherit from the pi that
 * launched it. They describe this session or the terminal it sits in,
 * and every shell the new terminal opens would otherwise carry them:
 * a stray `PI_SESSION_ID` points a new pi at the wrong session, and a
 * stray `TMUX` or `KITTY_WINDOW_ID` makes the new terminal's shells
 * believe they sit somewhere they do not. Everything else the person
 * set, `PI_CACHE_RETENTION` included, is theirs and passes through.
 */
export const SESSION_ONLY_VARIABLES: readonly string[] = [
	"PI_CODING_AGENT",
	"PI_MODEL",
	"PI_PROVIDER",
	"PI_REASONING_LEVEL",
	"PI_SESSION_FILE",
	"PI_SESSION_ID",
	"QUEST_WORKFLOW_AUTOLOAD_ID",
	"KITTY_LISTEN_ON",
	"KITTY_PID",
	"KITTY_PUBLIC_KEY",
	"KITTY_WINDOW_ID",
	"WEZTERM_PANE",
	"WEZTERM_UNIX_SOCKET",
	"TMUX",
	"TMUX_PANE",
	"ZELLIJ",
	"ZELLIJ_PANE_ID",
	"ZELLIJ_SESSION_NAME",
];

/** The environment a newly launched terminal starts with. */
export function launchEnvironment(
	env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (SESSION_ONLY_VARIABLES.includes(key)) continue;
		out[key] = value;
	}
	return out;
}

/**
 * The argv that runs `command` under the person's login shell with
 * their startup files read, then leaves that shell running, for a
 * terminal that can only be handed a command.
 *
 * `-l -i` reads the login and interactive startup files, which is what
 * puts the right tools on PATH. The trailing `exec $SHELL -l` leaves a
 * shell behind once the command exits, as a typed line would. Prompt
 * hooks such as direnv's do not run under `-c`, so `wrap` lets the
 * person put a command of their own in front, with `{cwd}` filled in.
 */
export function loginShellArgv(
	shell: string,
	command: string,
	options: {
		readonly env?: Readonly<Record<string, string>>;
		readonly wrap?: readonly string[];
		readonly cwd?: string;
	} = {},
): string[] {
	const wrapped = options.wrap?.length
		? `${options.wrap.map((part) => shellQuote(part.replaceAll("{cwd}", options.cwd ?? "."))).join(" ")} ${command}`
		: command;
	const line = typedLine(wrapped, options.env).trimEnd();
	return [shell, "-l", "-i", "-c", `${line}; exec ${shellQuote(shell)} -l`];
}
