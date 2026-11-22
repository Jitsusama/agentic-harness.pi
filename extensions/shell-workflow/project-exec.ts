/**
 * How a folder's own extensions run commands: inside the session's
 * sandbox, as the agent's own commands do. pi runs every extension's
 * `pi.exec` outside it, so a folder's extension, such as one that lints
 * each file the agent writes, could run a program whose settings a
 * sandboxed command wrote, and those settings could run code outside. A
 * host's pi, patched, hands a folder's extensions' exec to the one a user
 * extension sets, and refuses it until one does; plain pi has no way to
 * set it, and runs them as it always has.
 *
 * This bounds what a folder's extension runs, not the extension itself:
 * its code loads in pi's own process, and a fenced command can write a
 * folder's `.pi`. That is held by pi's trust in the folder and by
 * reading a folder's `.pi` before a host loads it again.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { constants, homedir } from "node:os";
import { relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
	ExecOptions,
	ExecResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { placedCommand } from "../../lib/internal/priority/place.ts";
import { type Sandbox, wrapFor } from "../../lib/internal/sandbox/sandbox.ts";
import { quoted } from "../../lib/internal/sandbox/sandbox-shell.ts";
import { systemProgram } from "../../lib/internal/sandbox/system-program.ts";
import {
	guardedEnvironment,
	SSH_GUARD_OFF,
	type SshGuard,
} from "../../lib/internal/shell/ssh-guard.ts";
import { withoutInteraction } from "./environment.ts";

/** Runs a folder's extension's command, given the folder it runs in. */
export type ProjectExec = (
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
) => Promise<ExecResult>;

/** A pi whose host build lets a user extension set how a folder's run. */
type SetsProjectExec = ExtensionAPI & {
	setProjectExec(exec: ProjectExec): void;
};

/** Whether this pi can be told how a folder's extensions run commands. */
export function setsProjectExec(pi: ExtensionAPI): pi is SetsProjectExec {
	return "setProjectExec" in pi && typeof pi.setProjectExec === "function";
}

/**
 * The most output kept, stdout and stderr together. A host's pi is one
 * process for every conversation and a lint may run after each edit, so
 * a sandboxed program saying without end could fill it; a linter's
 * useful output is kilobytes, and the fence's own pre-flight keeps as
 * much.
 */
export const MOST_OUTPUT = 16 * 1024 * 1024;
/** How long a stopped command has to end before it is killed outright. */
const KILL_AFTER_MS = 5000;
/**
 * How long a command killed outright has before the call ends anyway,
 * its pipes let go: a process that left the group can hold them open.
 */
const GIVE_UP_AFTER_KILL_MS = 1000;
/**
 * How long output may stay quiet once the command has exited before its
 * pipes are let go, as pi's own exec waits: a descendant left running
 * can hold them open for good.
 */
const QUIET_AFTER_EXIT_MS = 100;
/**
 * How long output is read at most once the command has exited, quiet or
 * not, so a descendant that keeps writing can't hold the call open.
 */
const MOST_AFTER_EXIT_MS = 2000;

/** What a refused command answers, nothing having run. */
function refusal(reason: string): ExecResult {
	return { stdout: "", stderr: `${reason}\n`, code: 126, killed: false };
}

/** Signals `child`'s whole process group, which it leads. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		// The group has already gone.
	}
}

/**
 * Runs `script` with the shell at `shell` in `cwd` with `env`, as pi's
 * exec runs a program: its time limit and abort signal held over the
 * whole process group it leads, its output decoded across chunks and kept
 * to `most` bytes, and its end read once it exits and its pipes close,
 * fall quiet or have been read for long enough.
 */
function run(
	shell: string,
	script: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	options: ExecOptions,
	most: number,
): Promise<ExecResult> {
	return new Promise((settle) => {
		let child: ChildProcess;
		try {
			child = spawn(shell, ["-c", script], {
				cwd,
				env,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			settle({
				stdout: "",
				stderr: `${shell} didn't start in ${cwd}: ${(error as Error).message}\n`,
				code: 1,
				killed: false,
			});
			return;
		}
		const out = new StringDecoder("utf8");
		const err = new StringDecoder("utf8");
		let stdout = "";
		let stderr = "";
		let bytes = 0;
		let killed = false;
		let tooMuch = false;
		let exited: number | undefined;
		let settled = false;
		const timers = new Set<NodeJS.Timeout>();
		const after = (ms: number, then: () => void) => {
			const timer = setTimeout(() => {
				timers.delete(timer);
				then();
			}, ms);
			timers.add(timer);
			return timer;
		};
		let quiet: NodeJS.Timeout | undefined;
		const done = (code: number) => {
			if (settled) return;
			settled = true;
			for (const timer of timers) clearTimeout(timer);
			options.signal?.removeEventListener("abort", stop);
			child.stdout?.destroy();
			child.stderr?.destroy();
			// What it left in its group goes with the call.
			signalGroup(child, "SIGKILL");
			const said = stderr + err.end();
			settle({
				stdout: stdout + out.end(),
				stderr: tooMuch
					? `${said}\nStopped: it said more than ${most} bytes.\n`
					: said,
				code: (tooMuch || killed) && code === 0 ? 1 : code,
				killed,
			});
		};
		function stop() {
			if (killed) return;
			killed = true;
			signalGroup(child, "SIGTERM");
			after(KILL_AFTER_MS, () => {
				signalGroup(child, "SIGKILL");
				after(GIVE_UP_AFTER_KILL_MS, () => done(exited ?? 137));
			});
			// Once it has exited, nothing is left to wait for but its pipes.
			if (exited !== undefined) done(exited);
		}
		const waitQuiet = () => {
			if (quiet) {
				clearTimeout(quiet);
				timers.delete(quiet);
			}
			quiet = after(QUIET_AFTER_EXIT_MS, () => done(exited ?? 1));
		};
		const take = (chunk: Buffer, into: "out" | "err") => {
			if (tooMuch) return;
			if (exited !== undefined) waitQuiet();
			const room = most - bytes;
			const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
			bytes += kept.length;
			if (into === "out") stdout += out.write(kept);
			else stderr += err.write(kept);
			if (chunk.length > room) {
				tooMuch = true;
				stop();
			}
		};
		child.on("error", (error) => {
			stderr += `${shell} didn't start in ${cwd}: ${error.message}\n`;
			done(1);
		});
		child.stdout?.on("data", (chunk: Buffer) => take(chunk, "out"));
		child.stderr?.on("data", (chunk: Buffer) => take(chunk, "err"));
		if (options.timeout && options.timeout > 0) after(options.timeout, stop);
		if (options.signal?.aborted) stop();
		else options.signal?.addEventListener("abort", stop, { once: true });
		child.on("exit", (code, signal) => {
			exited = code ?? 128 + (signal ? constants.signals[signal] : 0);
			if (killed) {
				done(exited);
				return;
			}
			waitQuiet();
			after(MOST_AFTER_EXIT_MS, () => done(exited ?? 1));
		});
		child.on("close", (code) => done(code ?? exited ?? 1));
	});
}

/** Whether `path` is `folder` or lies within it. */
function within(path: string, folder: string): boolean {
	const way = relative(resolve(folder), resolve(path));
	return way === "" || (!way.startsWith("..") && !way.startsWith("/"));
}

/** What a folder's extensions' exec is built from. */
export interface ProjectExecParts {
	/** The session's sandbox, as the agent's commands run in it. */
	readonly sandbox: Sandbox;
	/** The conversation's environment, read as each command starts. */
	readonly environment: () => NodeJS.ProcessEnv;
	/** The session's folder, which a command may run in or within. */
	readonly folder: () => string;
	/** Whether ssh to the person's own machines is refused, as it starts. */
	readonly sshGuard?: () => SshGuard;
	readonly home?: string;
	/**
	 * The shell that runs the wrap outside the sandbox, found only where
	 * the system alone puts programs: found on `PATH`, it could be one a
	 * fenced command planted in a folder the fence leaves writable.
	 */
	readonly shell?: () => string | undefined;
	readonly wrapping?: typeof wrapFor;
	readonly most?: number;
}

/**
 * The exec a folder's extensions run commands through: its environment
 * built as the agent's commands' is, wrapped in the session's sandbox and
 * placed as they are, so it lands where they do and is refused where
 * they are refused. A folder outside the session's is refused, since the
 * fence grants what it lets a command write from where it runs. Anything
 * that fails before the command starts answers as a refusal rather than
 * throwing. With no sandbox asked for, a command runs as pi would run it.
 */
export function projectExecIn(parts: ProjectExecParts): ProjectExec {
	const {
		sandbox,
		environment,
		folder,
		sshGuard = () => SSH_GUARD_OFF,
		home = homedir(),
		shell = () => systemProgram("bash"),
		wrapping = wrapFor,
		most = MOST_OUTPUT,
	} = parts;
	return async (command, args, cwd, options = {}) => {
		const script = [command, ...args].map(quoted).join(" ");
		let ready: { bash: string; text: string; env: NodeJS.ProcessEnv };
		try {
			const session = folder();
			if (!within(cwd, session))
				return refusal(
					`A folder's extension may run a command only in its session's folder, ${session}, not ${cwd}.`,
				);
			const bash = shell();
			if (!bash)
				return refusal(
					"A folder's extension's command needs bash from the system's own profile, and none is there.",
				);
			const plain = withoutInteraction({
				command: script,
				cwd,
				env: environment(),
			});
			const env = guardedEnvironment(plain.env, sshGuard(), sandbox.kind);
			const wrap = wrapping(sandbox, { cwd, env }, home);
			const text = placedCommand(
				script,
				cwd,
				wrap ?? ((run: string) => `exec ${run}`),
			);
			ready = { bash, text, env };
		} catch (error) {
			return refusal(
				`A folder's extension's command didn't start: ${(error as Error).message}`,
			);
		}
		return run(ready.bash, ready.text, cwd, ready.env, options, most);
	};
}

/** The exec left once a session has ended: every command refused. */
export const endedProjectExec: ProjectExec = async () =>
	refusal("A folder's extension may run no command once its session ends.");
