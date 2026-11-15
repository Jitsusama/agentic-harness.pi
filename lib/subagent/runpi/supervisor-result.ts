/**
 * What a supervisor said: the lines it prints while it runs, the
 * result file it leaves, and what can still be found about one that
 * never reported.
 */

import type { ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import type { ReviewerRunPaths, ReviewerTerminalState } from "../artifacts.ts";
import type { ReviewerError } from "../reviewer-error.ts";
import type { RunPiResult } from "../subagent.ts";

/** The result file a supervisor writes when its run ends. */
export interface SupervisorResultFile {
	readonly state?: ReviewerTerminalState;
	readonly exitCode: number;
	readonly finalAssistantText: string;
	readonly usage?: RunPiResult["usage"];
	readonly sessionIds?: RunPiResult["sessionIds"];
	readonly warnings?: readonly string[];
	readonly stderrTail?: string;
	readonly verification?: RunPiResult["verification"];
	readonly journal?: RunPiResult["journal"];
	readonly journalWarnings?: RunPiResult["journalWarnings"];
	readonly error?: ReviewerError;
	readonly artifacts?: RunPiResult["artifacts"];
}

/**
 * How long ago a file was last written, in milliseconds.
 *
 * Clamped at zero because a clock that moved between the write and
 * the read should not report a negative age, which reads as a file
 * written in the future and sends the reader after the wrong thing.
 */
async function ageOf(path: string): Promise<number> {
	try {
		const { mtimeMs } = await stat(path);
		return Math.max(0, Math.round(Date.now() - mtimeMs));
	} catch {
		// The file was readable a moment ago, so this is a race with
		// cleanup rather than a real answer. Nothing is claimed.
		return 0;
	}
}

/**
 * What can still be told about a supervisor that never reported.
 *
 * Read from disk and from the process rather than guessed, because
 * the guesses are all plausible and only one of them is true: a
 * process that never started looks nothing like one that ran and
 * died, and both look like silence from here. The supervisor keeps
 * a lease and a progress file precisely so its state outlives it.
 */
export async function supervisorPostMortem(
	supervisor: ChildProcess,
	paths: ReviewerRunPaths,
): Promise<string> {
	// Neither field is set until the process is gone, so both being
	// null is how "still running" is spelled.
	const running =
		supervisor.exitCode === null && supervisor.signalCode === null;
	const said: string[] = [
		running
			? `pid ${supervisor.pid ?? "unknown"} was still running`
			: `already gone (exit ${supervisor.exitCode}, ` +
				`signal ${supervisor.signalCode})`,
	];
	for (const [what, path] of [
		["lease", paths.leasePath],
		["progress", paths.progressPath],
	] as const) {
		try {
			const raw = JSON.parse(await readFile(path, "utf-8")) as {
				state?: unknown;
			};
			// The age matters as much as the state, and for a while only
			// the state was reported. Both ways this fails say "running":
			// a supervisor starved of CPU is still writing, so its last
			// word is seconds old, while one that wedged early wrote once
			// and stopped, so its last word is as old as the whole wait.
			// Without the age a CI log cannot say which happened, which
			// is exactly the question an unreproducible hang turns on.
			said.push(
				`${what} says ${JSON.stringify(raw.state ?? raw)}, ` +
					`last written ${await ageOf(path)}ms ago`,
			);
		} catch {
			// Absent is the interesting answer here: no lease means the
			// supervisor never got as far as its first write.
			said.push(`no ${what} file`);
		}
	}
	return `What was found: ${said.join("; ")}.`;
}

/**
 * Turn the supervisor's durable result into the caller's, so the
 * close path and the exit backstop cannot describe one run two
 * different ways.
 */
export function fromResult(
	result: SupervisorResultFile,
	warnings: readonly string[],
	stderrTail: string,
): RunPiResult {
	return {
		exitCode: result.exitCode,
		finalAssistantText: result.finalAssistantText,
		...(result.state ? { state: result.state } : {}),
		...(result.usage ? { usage: result.usage } : {}),
		...(result.sessionIds ? { sessionIds: result.sessionIds } : {}),
		warnings: [...warnings, ...(result.warnings ?? [])],
		stderrTail: result.stderrTail ?? stderrTail,
		...(result.verification ? { verification: result.verification } : {}),
		...(result.journal ? { journal: result.journal } : {}),
		...(result.journalWarnings
			? { journalWarnings: result.journalWarnings }
			: {}),
		...(result.error ? { error: result.error } : {}),
		...(result.artifacts ? { artifacts: result.artifacts } : {}),
	};
}

/**
 * One line of the supervisor's stdout as an event, or null for a
 * blank line or one that isn't JSON, which is warned about.
 */
export function parseSupervisorLine(
	line: string,
	warnings: string[],
): Record<string, unknown> | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>;
		return typeof parsed === "object" && parsed !== null ? parsed : null;
	} catch {
		warnings.push(
			`Malformed supervisor protocol line: ${truncate(trimmed, 80)}`,
		);
		return null;
	}
}

/**
 * The process group a started event names, when it names a real one.
 *
 * Zero and one are refused, not merely unlikely: signalling group zero
 * reaches our own group, and a supervisor that never spawned reports its
 * child's pid as zero.
 */
export function groupOf(event: Record<string, unknown>): number | null {
	const group = event.pgid ?? event.pid;
	return typeof group === "number" && Number.isInteger(group) && group > 1
		? group
		: null;
}

/** The result file at path, or null when it is missing or unreadable. */
export async function readResult(
	path: string,
): Promise<SupervisorResultFile | null> {
	try {
		return JSON.parse(await readFile(path, "utf-8")) as SupervisorResultFile;
	} catch {
		return null;
	}
}

/** The end of text that fits in maxBytes, cut between characters. */
export function tail(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let start = text.length - 1;
	while (start > 0) {
		const candidate = text.slice(start);
		if (Buffer.byteLength(candidate) > maxBytes) return text.slice(start + 1);
		start--;
	}
	return text;
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}...`;
}
