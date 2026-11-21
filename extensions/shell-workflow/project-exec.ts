/**
 * How a folder's own extensions run commands: inside the session's
 * sandbox, as the agent's own commands do. pi runs every extension's
 * `pi.exec` outside it, so a folder's extension, such as one that lints
 * each file the agent writes, could run a program whose settings a
 * sandboxed command wrote, and those settings could run code outside. A
 * host's pi, patched, hands a folder's extensions' exec to the one a user
 * extension sets, and refuses it until one does; plain pi has no way to
 * set it, and runs them as it always has.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import type {
	ExecOptions,
	ExecResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { type Sandbox, wrapFor } from "../../lib/internal/sandbox/sandbox.ts";
import { quoted } from "../../lib/internal/sandbox/sandbox-shell.ts";

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
 * The most output kept. pi's own exec keeps however much a program says;
 * a sandboxed program could say enough to fill pi's memory, so it is
 * stopped once it passes this.
 */
export const MOST_OUTPUT = 256 * 1024 * 1024;
/** How long a stopped command has to end before it is killed outright. */
const KILL_AFTER_MS = 5000;
/**
 * How long output may stay quiet once the command has exited before its
 * pipes are let go, as pi's own exec waits: a descendant left running
 * can hold them open for good.
 */
const QUIET_AFTER_EXIT_MS = 100;

/**
 * Runs `script` in bash in `cwd` with `env`, as pi's exec runs a program:
 * its time limit and abort signal held, its output decoded across chunks
 * and kept to `most` bytes, and its end read once it exits and its pipes
 * close or fall quiet.
 */
function bash(
	script: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	options: ExecOptions = {},
	most = MOST_OUTPUT,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-c", script], {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const out = new StringDecoder("utf8");
		const err = new StringDecoder("utf8");
		let stdout = "";
		let stderr = "";
		let bytes = 0;
		let killed = false;
		let tooMuch = false;
		let force: NodeJS.Timeout | undefined;
		let quiet: NodeJS.Timeout | undefined;
		let exited: number | undefined;
		let settled = false;
		const stop = () => {
			if (killed) return;
			killed = true;
			child.kill("SIGTERM");
			force = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);
			force.unref();
		};
		const done = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(limit);
			clearTimeout(force);
			clearTimeout(quiet);
			options.signal?.removeEventListener("abort", stop);
			child.stdout.destroy();
			child.stderr.destroy();
			const said = stderr + err.end();
			resolve({
				stdout: stdout + out.end(),
				stderr: tooMuch
					? `${said}\nStopped: it said more than ${most} bytes.\n`
					: said,
				code: tooMuch && code === 0 ? 1 : code,
				killed,
			});
		};
		const waitQuiet = () => {
			clearTimeout(quiet);
			quiet = setTimeout(() => done(exited ?? 1), QUIET_AFTER_EXIT_MS);
		};
		const take = (chunk: Buffer, into: "out" | "err") => {
			if (exited !== undefined) waitQuiet();
			if (tooMuch) return;
			bytes += chunk.length;
			if (bytes > most) {
				tooMuch = true;
				stop();
				return;
			}
			if (into === "out") stdout += out.write(chunk);
			else stderr += err.write(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => take(chunk, "out"));
		child.stderr.on("data", (chunk: Buffer) => take(chunk, "err"));
		const limit =
			options.timeout && options.timeout > 0
				? setTimeout(stop, options.timeout)
				: undefined;
		if (options.signal?.aborted) stop();
		options.signal?.addEventListener("abort", stop, { once: true });
		child.on("error", (error) => {
			stderr += error.message;
			done(1);
		});
		child.on("exit", (code) => {
			exited = code ?? 1;
			waitQuiet();
		});
		child.on("close", (code) => done(code ?? exited ?? 1));
	});
}

/**
 * The exec a folder's extensions run commands through: wrapped in
 * `sandbox` with the conversation's environment, so it lands where the
 * agent's own commands do, refused where they are refused. With no
 * sandbox asked for, a command runs as pi would run it.
 */
export function projectExecIn(
	sandbox: Sandbox,
	environment: () => NodeJS.ProcessEnv,
	home: string = homedir(),
	wrapping: typeof wrapFor = wrapFor,
	most = MOST_OUTPUT,
): ProjectExec {
	return (command, args, cwd, options) => {
		const env = environment();
		const wrap = wrapping(sandbox, { cwd, env }, home);
		const script = [command, ...args].map(quoted).join(" ");
		return bash(
			wrap ? wrap(script) : `exec ${script}`,
			cwd,
			env,
			options,
			most,
		);
	};
}
