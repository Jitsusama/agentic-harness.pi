/**
 * Running a command with nobody at the keyboard.
 *
 * A host's own exec is built for a person watching: the child shares the
 * host's terminal, so when git wants a password or ssh a passphrase it
 * opens that terminal and waits. Inside pi the terminal belongs to pi's
 * interface, so the prompt is drawn over it, the keys never reach it, and
 * the tool that ran git waits forever with nothing the person can press.
 * Closing stdin does not help, since a prompt opens the terminal itself.
 *
 * So the child leads a session of its own, which leaves it no terminal to
 * open, reads end of input from stdin, is told by git's and gh's own
 * variables not to ask, and is stopped along with everything it started
 * when its signal fires or its clock runs out. Signing through an agent
 * or a helper still works, since neither needs a terminal: every commit
 * made through pi's own bash tool, which runs the same way, is signed.
 *
 * What a child says is held in memory, so each stream has a ceiling too.
 * A string can't grow past V8's limit, and the throw from a stream's
 * handler has no caller to reach: it ended whole pi sessions mid-call,
 * twice on 12 November, on a diff that kept streaming. Past the ceiling
 * the child is stopped and the call fails saying why, rather than
 * answering with part of its output as though it were all of it.
 */

import { spawn } from "node:child_process";
import { count } from "../../ui/count.ts";
import { callSignal } from "./call-signal.ts";
import type { Exec, ExecResult } from "./exec.ts";

/** The exit code of a command its clock stopped, as `timeout(1)` reports. */
export const EXIT_TIMED_OUT = 124;

/** The exit code of a command its signal stopped, as a shell reports SIGINT. */
export const EXIT_ABORTED = 130;

/**
 * The exit code of a command stopped for saying too much, as a shell
 * reports a writer whose reader stopped listening (SIGPIPE).
 */
export const EXIT_SAID_TOO_MUCH = 141;

/**
 * How much of each stream is held, in characters. A quarter of V8's
 * longest string, so a caller can still copy or join what it gets.
 */
const MAX_OUTPUT_CHARS = 128 * 1024 * 1024;

/** How long a stopped command has to exit before it is killed outright. */
const KILL_GRACE_MS = 2000;

/**
 * What git and gh are told so they fail rather than ask. Each is the tool's
 * own documented switch; a caller that knows better passes its own `env`.
 */
export const NONINTERACTIVE_ENV: Readonly<Record<string, string>> = {
	GIT_TERMINAL_PROMPT: "0",
	GCM_INTERACTIVE: "never",
	GH_PROMPT_DISABLED: "1",
	GIT_EDITOR: "true",
};

/** How an unattended command is bounded and where it runs. */
export interface SpawnExecOptions {
	/** Stops the command, and everything it started, when it fires. */
	signal?: AbortSignal;
	/** Stops the command after this long. No clock when absent. */
	timeoutMs?: number;
	/** How long a stopped command may take to exit before it is killed. */
	killGraceMs?: number;
	/** How much of each stream may be held before the command is stopped. */
	maxOutputChars?: number;
	/** Laid over this process's environment and the non-interactive defaults. */
	env?: Readonly<Record<string, string>>;
	/** Where the command runs. This process's directory when absent. */
	cwd?: string;
}

/**
 * An `Exec` whose commands cannot prompt and cannot outlive their signal
 * or clock. Never throws: a command that could not start reports a failed
 * exit with the reason on stderr, and a stopped one reports
 * `EXIT_ABORTED`, `EXIT_TIMED_OUT` or `EXIT_SAID_TOO_MUCH` with what it
 * had said so far.
 */
export function spawnExec(options: SpawnExecOptions = {}): Exec {
	// The call is read when the command starts, not when the exec is
	// made: an exec is usually made once and used by every call after.
	return (command, args) =>
		runUnattended(command, args, {
			...options,
			...stoppedBy(options.signal, callSignal()),
		});
}

/** Whichever of the command's own signal and its call's fires first. */
function stoppedBy(
	own: AbortSignal | undefined,
	call: AbortSignal | undefined,
): { signal?: AbortSignal } {
	if (own && call && own !== call)
		return { signal: AbortSignal.any([own, call]) };
	const either = own ?? call;
	return either ? { signal: either } : {};
}

function runUnattended(
	command: string,
	args: string[],
	options: SpawnExecOptions,
): Promise<ExecResult> {
	const { signal } = options;
	if (signal?.aborted) {
		return Promise.resolve({
			code: EXIT_ABORTED,
			stdout: "",
			stderr: `${command} aborted before it started`,
		});
	}
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, ...NONINTERACTIVE_ENV, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
			// A session of its own: no controlling terminal to prompt on,
			// and a process group to stop as one.
			detached: true,
		});
		let stdout = "";
		let stderr = "";
		let stopped: { code: number; why: string } | undefined;
		let killer: NodeJS.Timeout | undefined;
		const ceiling = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
		// What fits under the ceiling is kept; the first chunk past it stops
		// the command, and anything after is let go.
		const held = (said: string, chunk: string, stream: string): string => {
			const room = ceiling - said.length;
			if (chunk.length <= room) return said + chunk;
			stop(
				EXIT_SAID_TOO_MUCH,
				`${command} was stopped: its ${stream} passed ${count(ceiling, "character")}`,
			);
			return room > 0 ? said + chunk.slice(0, room) : said;
		};
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout = held(stdout, chunk, "stdout");
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr = held(stderr, chunk, "stderr");
		});

		const stop = (code: number, why: string): void => {
			if (stopped !== undefined) return;
			stopped = { code, why };
			signalGroup(child.pid, "SIGTERM");
			killer = setTimeout(
				() => signalGroup(child.pid, "SIGKILL"),
				options.killGraceMs ?? KILL_GRACE_MS,
			);
		};
		const onAbort = (): void => stop(EXIT_ABORTED, `${command} aborted`);
		signal?.addEventListener("abort", onAbort, { once: true });
		const clock =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(
						() =>
							stop(
								EXIT_TIMED_OUT,
								`${command} timed out after ${options.timeoutMs} ms`,
							),
						options.timeoutMs,
					);

		let settled = false;
		const settle = (result: ExecResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(clock);
			clearTimeout(killer);
			signal?.removeEventListener("abort", onAbort);
			// Whatever the command left running in its group goes with it.
			if (stopped !== undefined) signalGroup(child.pid, "SIGKILL");
			resolve(result);
		};

		child.on("error", (error) => {
			settle({ code: 1, stdout, stderr: `${stderr}${error.message}` });
		});
		// `close` rather than `exit`, so the output is all read; a stopped
		// group's pipes close once the group is gone.
		child.on("close", (code) => {
			if (stopped !== undefined) {
				const said =
					stderr === "" || stderr.endsWith("\n") ? stderr : `${stderr}\n`;
				settle({ code: stopped.code, stdout, stderr: `${said}${stopped.why}` });
				return;
			}
			settle({ code: code ?? 1, stdout, stderr });
		});
	});
}

/** Signals a whole process group, which may already have gone. */
function signalGroup(pid: number | undefined, how: NodeJS.Signals): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, how);
	} catch {
		// ESRCH: the group has already exited, which is what was wanted.
	}
}
