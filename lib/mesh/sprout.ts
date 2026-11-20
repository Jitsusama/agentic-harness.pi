/**
 * Sprouting a cell from inside pi: new work fed in as words or a link,
 * started by the node as a session of its own, tied to the cell that
 * asked.
 *
 * It asks through `mycelium sprout` rather than the node's socket, as
 * the rest of node.ts does, because the program judges the folder on
 * this machine's disk before it asks, falls back to a plain start on an
 * older node, and is what the launcher and a terminal ask through, so
 * pi starts work exactly as they do. Its JSON answer is the node's own
 * reply, read as a start's is (node.ts).
 */

import { execFile } from "node:child_process";
import { START_PATIENCE_MS, type StartAnswer, startedFrom } from "./node.ts";

/** New work to sprout, as the person or the session says it. */
export interface Sprouting {
	/** The work: a link alone, or words. */
	readonly words: string;
	/** The repository's folder it works in; mycelium finds one otherwise. */
	readonly folder?: string;
	/** The machine it starts on, by its node's name; this one otherwise. */
	readonly on?: string;
	/** The cell it comes from, by address, which its quest is tied to. */
	readonly from?: string;
}

/** What running a program came to. */
export interface Ran {
	/** Its exit code, or nothing when it never ran or was stopped. */
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	/** There is no such program here. */
	readonly missing?: boolean;
	/** It ran past its patience and was stopped. */
	readonly timedOut?: boolean;
}

/** Runs a program with its arguments, never through a shell. */
export type RunProgram = (
	program: string,
	args: readonly string[],
	options: { readonly cwd: string; readonly timeoutMs: number },
) => Promise<Ran>;

/**
 * How long `mycelium sprout` has: the node's own start patience, and a
 * little beside it for the program to judge the folder and say so.
 */
export const SPROUT_PATIENCE_MS = START_PATIENCE_MS + 10_000;

/** The most of mycelium's own words a refusal says. */
const MOST_SAID = 500;

/**
 * The arguments `mycelium sprout` is run with: its answer as JSON, and
 * the words after `--`, so words that open with a dash start no option.
 */
export function sproutArguments(sprouting: Sprouting): string[] {
	const named = (flag: string, value: string | undefined): string[] =>
		value?.trim() ? [flag, value.trim()] : [];
	return [
		"sprout",
		"-o",
		"json",
		...named("--in", sprouting.folder),
		...named("--on", sprouting.on),
		...named("--from", sprouting.from),
		"--",
		sprouting.words.trim(),
	];
}

/**
 * Sprouts `sprouting` as asked from `cwd`, answering where it started and
 * how to join it, or why it didn't, in mycelium's or the node's words.
 */
export async function sprout(
	sprouting: Sprouting,
	cwd: string,
	run: RunProgram = runProgram,
): Promise<StartAnswer> {
	if (!sprouting.words.trim()) {
		return {
			ok: false,
			reason: "a sprout needs words or a link to start from",
		};
	}
	const ran = await run("mycelium", sproutArguments(sprouting), {
		cwd,
		timeoutMs: SPROUT_PATIENCE_MS,
	});
	if (ran.missing) {
		return {
			ok: false,
			reason: "mycelium isn't installed here, so nothing can be sprouted",
		};
	}
	if (ran.timedOut) {
		return {
			ok: false,
			reason: `mycelium sprout answered nothing within ${SPROUT_PATIENCE_MS / 1000} s; the start may still land, so look for it before asking again`,
			mayLand: true,
		};
	}
	const line = ran.stdout.trim().split("\n").at(-1);
	if (line) return startedFrom(line);
	const said = ran.stderr.trim().slice(0, MOST_SAID);
	return {
		ok: false,
		reason:
			said ||
			`mycelium sprout ended with ${ran.code ?? "no code"} and said nothing`,
	};
}

/** Runs a program as {@link RunProgram} says, through node's execFile. */
export const runProgram: RunProgram = (program, args, options) =>
	new Promise((resolve) => {
		execFile(
			program,
			[...args],
			{ cwd: options.cwd, timeout: options.timeoutMs, encoding: "utf8" },
			(error, stdout, stderr) => {
				const code =
					error === null
						? 0
						: typeof error.code === "number"
							? error.code
							: null;
				resolve({
					code,
					stdout,
					stderr,
					...(error?.code === "ENOENT" ? { missing: true } : {}),
					...(error?.killed === true ? { timedOut: true } : {}),
				});
			},
		);
	});
