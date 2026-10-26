/**
 * Running a terminal's control cli, on a clock.
 *
 * Every deep driver talks to a running terminal through a cli that
 * reaches it over a socket, and a terminal that is wedged, or a socket
 * left behind by one that died, accepts and never answers. Quest takes
 * its calls one at a time, so one hung cli used to hold every later
 * quest call. Each call here ends at its clock.
 */

import { spawn } from "node:child_process";

/**
 * How long one terminal cli call may take.
 *
 * The cli answers as soon as the terminal has acted, well under a
 * second. One that has not answered in ten is talking to a terminal
 * that is wedged or to a socket a dead one left behind.
 */
export const TERMINAL_CLI_TIMEOUT_MS = 10_000;

/**
 * The most a cli may print before the call is treated as failed. A
 * listing of every window in a busy kitty, environments included, runs
 * to a few hundred kilobytes, so the ceiling sits well above that.
 */
const CLI_OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;

/** What one cli call is run with. */
export interface CliCall {
	/** How long the call may take. */
	readonly timeout: number;
	/** Cancels the call. */
	readonly signal?: AbortSignal;
	/** The environment the cli runs in. Defaults to this process's. */
	readonly env?: NodeJS.ProcessEnv;
	/** Text written to the cli's stdin, which is closed after it. */
	readonly input?: string;
}

/** A cli that failed, with what it said on the way out. */
export class TerminalCliError extends Error {
	constructor(
		message: string,
		readonly stderr: string,
	) {
		super(message);
		this.name = "TerminalCliError";
	}
}

/** Run a cli and return its stdout, throwing on failure or at the clock. */
export function runCli(
	binary: string,
	args: readonly string[],
	call: CliCall,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, [...args], {
			env: call.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			...(call.signal ? { signal: call.signal } : {}),
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const settle = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(clock);
			if (error) reject(error);
			else resolve(stdout);
		};
		const clock = setTimeout(() => {
			child.kill("SIGKILL");
			settle(
				new TerminalCliError(
					`${binary} ${args[0] ?? ""} did not answer within ${call.timeout} ms`,
					stderr,
				),
			);
		}, call.timeout);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.length > CLI_OUTPUT_LIMIT_BYTES) {
				child.kill("SIGKILL");
				settle(new TerminalCliError(`${binary} printed too much`, stderr));
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => settle(error));
		child.on("close", (code, signal) => {
			if (code === 0) return settle();
			const said = stderr.trim();
			settle(
				new TerminalCliError(
					`${binary} ${args.join(" ")} ${signal ? `was killed by ${signal}` : `exited ${code}`}${said ? `: ${said}` : ""}`,
					stderr,
				),
			);
		});
		// A cli that exits before reading its input closes the pipe under
		// us; the exit code already says how it went.
		child.stdin.on("error", () => undefined);
		child.stdin.end(call.input ?? "");
	});
}
