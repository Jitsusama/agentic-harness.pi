/**
 * A kept call outlives the pi that started it: a move hands it on, and
 * its next owner says its end. pi's own spawn tracks each shell it
 * starts, and from 1.6 an interactive pi's quit, /host's included,
 * kills each one's process group (killTrackedDetachedChildren). So a
 * kept call a pi without pi-spawner started died with the pi that had
 * just handed it on: on 28 November E17 on htt66 met it, the shell gone
 * and only `timeout`, in a group of its own, left (OSPHT4 [e2df4710]).
 *
 * pi exports no way to untrack a shell, so a kept call pi would start,
 * this starts itself, detached as pi's are and untracked, and stops it
 * as pi would, its whole group, on its call's stop or time limit. Every
 * other command is still pi's own.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:os";
import {
	type BashOperations,
	getShellConfig,
} from "@earendil-works/pi-coding-agent";
import { KEEP_VARIABLE } from "./kept.ts";
import { killGroup } from "./spawner.ts";

/**
 * How long a kept shell's output is read past its exit, for what it left
 * running that holds its output open, as pi reads its own.
 */
const DRAIN_MS = 100;

/** The settings each call is run with, as pi's bash gives them. */
type Call = Parameters<BashOperations["exec"]>[2];

/** How a shell ended: its code, or the signal that ended it. */
interface Ended {
	code: number | null;
	signal: NodeJS.Signals | null;
}

/**
 * pi's bash operations `own`, with each kept call started apart from
 * pi's tracking, in the shell at `shellPath` or the one pi would find.
 */
export function keptApart(
	own: BashOperations,
	shellPath?: string,
): BashOperations {
	return {
		exec(command, cwd, call) {
			if (call.env?.[KEEP_VARIABLE] === undefined)
				return own.exec(command, cwd, call);
			let shell: ReturnType<typeof getShellConfig>;
			try {
				shell = getShellConfig(shellPath);
			} catch {
				// pi's own spawn says why the shell can't be found.
				return own.exec(command, cwd, call);
			}
			return runApart(shell, command, cwd, call);
		},
	};
}

/** Run `command` in a shell of its own group that nothing of pi's tracks. */
async function runApart(
	shell: ReturnType<typeof getShellConfig>,
	command: string,
	cwd: string,
	call: Call,
): Promise<{ exitCode: number | null }> {
	const fromStdin = shell.commandTransport === "stdin";
	const child = spawn(
		shell.shell,
		fromStdin ? shell.args : [...shell.args, command],
		{
			cwd,
			detached: true,
			env: call.env,
			stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
		},
	);
	if (fromStdin) {
		child.stdin?.on("error", () => {
			// A shell gone before reading its command says so in its end.
		});
		child.stdin?.end(command);
	}
	child.stdout?.on("data", call.onData);
	child.stderr?.on("data", call.onData);
	const stop = () => {
		if (child.pid !== undefined) killGroup(child.pid);
	};
	let timedOut = false;
	const timer =
		call.timeout !== undefined && call.timeout > 0
			? setTimeout(() => {
					timedOut = true;
					stop();
				}, call.timeout * 1000)
			: undefined;
	if (call.signal?.aborted) stop();
	else call.signal?.addEventListener("abort", stop, { once: true });
	try {
		const ended = await endOf(child);
		if (call.signal?.aborted) throw new Error("aborted");
		if (timedOut) throw new Error(`timeout:${call.timeout}`);
		return { exitCode: exitCodeOf(ended) };
	} finally {
		clearTimeout(timer);
		call.signal?.removeEventListener("abort", stop);
	}
}

/** The exit code pi reports: the code, or 128 and the signal's number. */
function exitCodeOf(ended: Ended): number {
	if (ended.code !== null) return ended.code;
	return ended.signal === null
		? 1
		: 128 + (constants.signals[ended.signal] ?? 0);
}

/**
 * How `child` ended, once its output has closed, or {@link DRAIN_MS}
 * past its exit while something it left holds that open.
 */
function endOf(child: ChildProcess): Promise<Ended> {
	return new Promise((settle, fail) => {
		let open = [child.stdout, child.stderr].filter((s) => s !== null).length;
		let ended: Ended | undefined;
		let drain: NodeJS.Timeout | undefined;
		const finish = () => {
			if (ended === undefined) return;
			clearTimeout(drain);
			child.stdout?.destroy();
			child.stderr?.destroy();
			settle(ended);
		};
		const closed = () => {
			open--;
			if (open === 0) finish();
		};
		child.stdout?.once("close", closed);
		child.stderr?.once("close", closed);
		child.once("error", fail);
		child.once("exit", (code, signal) => {
			ended = { code, signal };
			if (open === 0) finish();
			else drain = setTimeout(finish, DRAIN_MS);
		});
	});
}
