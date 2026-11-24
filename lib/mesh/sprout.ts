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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isRecord } from "../internal/record.ts";
import { systemProgram } from "../internal/sandbox/system-program.ts";
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
	/** The folder it was to run in is gone, so it never ran. */
	readonly noFolder?: boolean;
	/** It ran past its patience and was stopped. */
	readonly timedOut?: boolean;
	/** Whoever asked for it stopped it first. */
	readonly stopped?: boolean;
	/** Why it couldn't be started, as the system said, so it never ran. */
	readonly neverRan?: string;
}

/** Runs a program with its arguments, never through a shell. */
export type RunProgram = (
	program: string,
	args: readonly string[],
	options: {
		readonly cwd: string;
		readonly timeoutMs: number;
		readonly signal?: AbortSignal;
		/** Its whole environment, when not this process's own. */
		readonly env?: NodeJS.ProcessEnv;
	},
) => Promise<Ran>;

/**
 * How long `mycelium sprout` has: the node's own start patience, and a
 * little beside it for the program to judge the folder and say so.
 */
export const SPROUT_PATIENCE_MS = START_PATIENCE_MS + 10_000;

/** The most of mycelium's own words a refusal says. */
const MOST_SAID = 500;

/**
 * What a sprout that may have started says to do: a sprout has no name
 * to join under, so another ask starts a second cell.
 */
const LOOK_FIRST =
	"look for it in the launcher's Agents before asking again, since another ask starts a second cell";

/**
 * The arguments `mycelium sprout` is run with: its answer as JSON, each
 * named value joined to its flag by `=`, and the words after `--`, so
 * no value a model writes that opens with a dash starts an option.
 */
export function sproutArguments(sprouting: Sprouting): string[] {
	const named = (flag: string, value: string | undefined): string[] =>
		value?.trim() ? [`${flag}=${value.trim()}`] : [];
	return [
		"sprout",
		"-o",
		"json",
		...named(
			"--in",
			sprouting.folder?.trim().replace(/^~(?=\/|$)/u, homedir()),
		),
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
	signal?: AbortSignal,
): Promise<StartAnswer> {
	if (!sprouting.words.trim()) {
		return {
			ok: false,
			reason: "a sprout needs words or a link to start from",
		};
	}
	if (
		sprouting.on?.trim() &&
		/^~(?:\/|$)/u.test(sprouting.folder?.trim() ?? "")
	) {
		// ~ here is this machine's home, which another's may not be.
		return {
			ok: false,
			reason: `name the folder in full as it is on ${sprouting.on.trim()}, since ~ is read as this machine's home`,
		};
	}
	const ran = await run("mycelium", sproutArguments(sprouting), {
		cwd,
		timeoutMs: SPROUT_PATIENCE_MS,
		...(signal ? { signal } : {}),
	});
	if (ran.noFolder) {
		return {
			ok: false,
			reason: `this session's folder, ${cwd}, is gone, so mycelium can't run from it`,
		};
	}
	if (ran.missing) {
		return {
			ok: false,
			reason: "mycelium isn't installed here, so nothing can be sprouted",
		};
	}
	if (ran.neverRan) {
		return {
			ok: false,
			reason: `mycelium sprout couldn't be started here (${ran.neverRan}), so nothing was sprouted`,
		};
	}
	if (ran.timedOut) {
		return {
			ok: false,
			reason: `mycelium sprout answered nothing within ${SPROUT_PATIENCE_MS / 1000} s, so ${LOOK_FIRST}`,
			mayLand: true,
		};
	}
	if (ran.stopped) {
		return {
			ok: false,
			reason: `the turn was stopped before mycelium sprout answered, so ${LOOK_FIRST}`,
			mayLand: true,
		};
	}
	const line = ran.stdout.trim().split("\n").at(-1);
	const said = ran.stderr.trim().slice(0, MOST_SAID);
	// A failed run whose last line isn't the node's JSON says why on
	// stderr, which beats saying its stdout can't be read.
	if (ran.code === 0) return startedOrMayLand(line);
	if (ran.code === null) {
		// What it wrote before the signal counts only when it says started
		// or refused; anything else is a run cut short.
		const answer = line ? startedFrom(line) : undefined;
		if (answer && (answer.ok || (line && refusedByNode(line)))) return answer;
		// Ended by a signal nobody here sent, as the OOM killer's: its ask
		// may already be with the node.
		return {
			ok: false,
			reason: `mycelium sprout was ended before it answered${said ? ` (${said})` : ""}, so ${LOOK_FIRST}`,
			mayLand: true,
		};
	}
	if (line && (!said || isJson(line))) return startedFrom(line);
	return {
		ok: false,
		reason:
			said ||
			`mycelium sprout ended with ${ran.code ?? "no code"} and said nothing`,
	};
}

/**
 * What a sprout that ended well answered: started, or the node's own
 * refusal, else a reply this harness can't read, which may still have
 * started a cell, so the model looks before asking again.
 */
function startedOrMayLand(line: string | undefined): StartAnswer {
	const answer = line
		? startedFrom(line)
		: {
				ok: false as const,
				reason: "mycelium sprout ended with 0 and said nothing",
			};
	if (answer.ok || (line && refusedByNode(line))) return answer;
	return {
		ok: false,
		reason: `${answer.reason}, so ${LOOK_FIRST}`,
		mayLand: true,
	};
}

/** Whether `line` is the node's own refusal, `{ "Err": ... }`. */
function refusedByNode(line: string): boolean {
	try {
		const reply: unknown = JSON.parse(line);
		return isRecord(reply) && typeof reply.Err === "string";
	} catch {
		// Not JSON, so not the node's refusal.
		return false;
	}
}

/** Whether `line` parses as JSON. */
function isJson(line: string): boolean {
	try {
		JSON.parse(line);
		return true;
	} catch {
		// Not JSON, which is the answer asked for.
		return false;
	}
}

/**
 * Runs a program as {@link RunProgram} says, through node's execFile,
 * finding it with `find`: by default only in the system's profiles,
 * never on the environment's PATH. pi runs it unfenced, and a session's
 * PATH can hold a folder a fenced command writes, such as a project's
 * `.direnv/bin` (system-program.ts), so a planted `mycelium` there
 * would run as the person. One the profiles don't hold is missing.
 */
export function runsSystemPrograms(
	find: (program: string) => string | undefined = systemProgram,
): RunProgram {
	return (program, args, options) => {
		const found = find(program);
		if (found === undefined) {
			return Promise.resolve({
				code: null,
				stdout: "",
				stderr: "",
				missing: true,
			});
		}
		return runFound(found, args, options);
	};
}

/** Runs a program from the system's profiles, as {@link runsSystemPrograms} says. */
export const runProgram: RunProgram = runsSystemPrograms();

/** Runs the program at `program`, never failing but in what it resolves. */
const runFound: RunProgram = (program, args, options) =>
	new Promise((resolve) => {
		try {
			runFile(program, args, options, resolve);
		} catch (error) {
			// Node throws some spawn failures (ENOTDIR for a cwd that's a
			// file) rather than handing them to the callback.
			const why =
				isRecord(error) && typeof error.code === "string" ? error.code : "";
			resolve({
				code: null,
				stdout: "",
				stderr: "",
				neverRan: why || String(error),
			});
		}
	});

/** Runs `program` through execFile, resolving with what it came to. */
function runFile(
	program: string,
	args: readonly string[],
	options: Parameters<RunProgram>[2],
	resolve: (ran: Ran) => void,
): void {
	execFile(
		program,
		[...args],
		{
			cwd: options.cwd,
			timeout: options.timeoutMs,
			encoding: "utf8",
			...(options.signal ? { signal: options.signal } : {}),
			...(options.env ? { env: options.env } : {}),
		},
		(error, stdout, stderr) => {
			// A system error's code (EAGAIN, EACCES) is the spawn's own
			// failure: the program never ran. Node's own codes (ERR_...), such
			// as its kill of a run past its output's limit, come from one that
			// ran and may have asked the node.
			const failedToSpawn =
				typeof error?.code === "string" &&
				/^E[A-Z0-9]+$/u.test(error.code) &&
				error.code !== "ENOENT" &&
				error.name !== "AbortError"
					? error.code
					: undefined;
			const code =
				error === null ? 0 : typeof error.code === "number" ? error.code : null;
			resolve({
				code,
				stdout,
				stderr,
				// A folder that's gone fails as ENOENT too, never
				// running the program, which may well be installed.
				...(error?.code === "ENOENT"
					? existsSync(options.cwd)
						? { missing: true }
						: { noFolder: true }
					: {}),
				...(failedToSpawn ? { neverRan: failedToSpawn } : {}),
				...(error?.name === "AbortError"
					? { stopped: true }
					: error?.killed === true
						? { timedOut: true }
						: {}),
			});
		},
	);
}
