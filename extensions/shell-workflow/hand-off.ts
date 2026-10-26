/**
 * Handing a long command to the background.
 *
 * A bash call holds the session until the command ends, and the session
 * logs show what that costs: commands that ran for half an hour with
 * nothing on screen, until the person aborted them. A short timeout is
 * no answer, since it killed real builds. So a command still running
 * after a while is not killed but moved: its lifetime passes from the
 * call to a job, the call returns saying so, and the job says how the
 * command ended once it has.
 *
 * A session in a bash call hears neither the person nor the mesh until
 * the call returns, since pi steers messages in only between tool calls.
 * So the wait is a minute, not the five it once was, and `background:
 * false` no longer means never: on 2026-10-25 sessions passed it on
 * 1,210 of 1,381 bash calls since 19:00, and the three that went deaf
 * to the orchestrator for 20 to 31 minutes had all passed it, two of
 * them while waiting in the machine queue.
 *
 * The command itself is pi's, run by pi's own bash under a signal this
 * module owns. Until the hand-off that signal follows the call's, so
 * Escape kills the command as it always has; after it, it follows the
 * job's, so `/jobs` and the session ending do.
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	EventBus,
} from "@earendil-works/pi-coding-agent";
import { findJobHost } from "../../lib/jobs/index.ts";
import { firstText } from "../../lib/ui/index.ts";

/** How long a command may hold the call before it is handed off. */
export const HAND_OFF_MS = 60 * 1000;

/** Lines of output the hand-off shows, so the model can see where it was. */
export const HAND_OFF_LINES = 20;

/** Lines of output the finished job says before pointing at the rest. */
export const FINISHED_LINES = 40;

/** Longest label a job is given, from the command's first line. */
const LABEL_CHARS = 60;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/** What running one bash call needs. */
export interface Call<T> {
	readonly command: string;
	/** The call being run, named on its job if it is handed off. */
	readonly toolCallId?: string;
	/** True to hand off at once; false or unset, after a while. */
	readonly background?: boolean;
	/** Made by a codemode script, which needs the real result. */
	readonly nested: boolean;
	readonly signal: AbortSignal | undefined;
	readonly onUpdate: AgentToolUpdateCallback<T> | undefined;
	readonly bus: EventBus;
	/** Run the command under the given signal, reporting output as it comes. */
	readonly run: (
		signal: AbortSignal,
		onUpdate: AgentToolUpdateCallback<T>,
	) => Promise<AgentToolResult<T>>;
	readonly afterMs?: number;
	readonly now?: () => number;
	/** Keep a finished command's output somewhere the model can read it. */
	readonly keep?: (name: string, text: string) => string;
}

/** Write output to the system temp directory, as pi's bash does. */
function keepInTemp(name: string, text: string): string {
	const resultPath = join(tmpdir(), `pi-bash-${name}.log`);
	writeFileSync(resultPath, text);
	return resultPath;
}

/** A command, named in a line. */
export function labelOf(command: string): string {
	const line = command.trim().split("\n")[0]?.replace(/\s+/g, " ") ?? "";
	const more = command.trim().includes("\n") ? " ..." : "";
	if (line.length + more.length <= LABEL_CHARS) return `${line}${more}`;
	return `${line.slice(0, LABEL_CHARS - 3)}...`;
}

/** A span of time, in the words a person would use. */
export function spoken(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / MS_PER_SECOND));
	if (seconds < SECONDS_PER_MINUTE) {
		return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
	}
	const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
	const rest = seconds % SECONDS_PER_MINUTE;
	const said = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
	return rest === 0 ? said : `${said} ${rest}s`;
}

/** The last lines of some output. */
function lastLines(text: string, count: number): string {
	const lines = text.replace(/\n+$/, "").split("\n");
	return lines.slice(-count).join("\n");
}

/** Whether the command holds its output back until it ends. */
export function holdsOutputBack(command: string): boolean {
	return /\|\s*(tail|head)\b/.test(command);
}

/** The exit code a finished bash result reports, when it says one. */
function exitCodeOf(result: AgentToolResult<unknown>): number | undefined {
	const structured = result.structuredContent;
	if (
		typeof structured !== "object" ||
		structured === null ||
		!("exit_code" in structured)
	) {
		return undefined;
	}
	const code = structured.exit_code;
	return typeof code === "number" ? code : undefined;
}

/**
 * Run a bash call, handing it to a job if it is still running when the
 * time comes. Answers with the command's own result when it ends first.
 */
export async function runOrHandOff<T>(
	call: Call<T>,
): Promise<AgentToolResult<T | undefined>> {
	const host = call.nested ? undefined : findJobHost(call.bus);
	const passThrough: AgentToolUpdateCallback<T> = (partial) =>
		call.onUpdate?.(partial);
	if (!host) {
		return await call.run(
			call.signal ?? new AbortController().signal,
			passThrough,
		);
	}

	const now = call.now ?? Date.now;
	const startedAt = now();
	const owned = new AbortController();
	const followCall = () => owned.abort(call.signal?.reason);
	if (call.signal?.aborted) owned.abort(call.signal.reason);
	else call.signal?.addEventListener("abort", followCall, { once: true });

	let handedOff = false;
	let latest = "";
	let lastOutputAt = startedAt;
	const running = call.run(owned.signal, (partial) => {
		const text = firstText(partial);
		if (text !== latest) {
			latest = text;
			lastOutputAt = now();
		}
		// The call has returned once handed off; its row is not ours to draw.
		if (!handedOff) call.onUpdate?.(partial);
	});

	const delay = call.background === true ? 0 : (call.afterMs ?? HAND_OFF_MS);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const due = new Promise<"due">((resolve) => {
		timer = setTimeout(() => resolve("due"), delay);
	});
	const first = await Promise.race([
		running.then(
			(result) => ({ result }),
			(error: unknown) => ({ error }),
		),
		due,
	]);
	clearTimeout(timer);
	if (first !== "due") {
		call.signal?.removeEventListener("abort", followCall);
		if ("error" in first) throw first.error;
		return first.result;
	}
	// Stopped in the instant the time came: it is ending, not moving.
	if (owned.signal.aborted) {
		call.signal?.removeEventListener("abort", followCall);
		return await running;
	}

	handedOff = true;
	call.signal?.removeEventListener("abort", followCall);
	const label = labelOf(call.command);
	const job = host.start({
		kind: "shell",
		label,
		...(call.toolCallId !== undefined ? { toolCallId: call.toolCallId } : {}),
	});
	if (job.signal.aborted) owned.abort(job.signal.reason);
	else {
		job.signal.addEventListener("abort", () => owned.abort(job.signal.reason), {
			once: true,
		});
	}

	const keep = call.keep ?? keepInTemp;
	// Job ids start again in every session; the file outlives the session.
	const fileName = `${process.pid}-${startedAt}-${job.id}`;
	running.then(
		(result) => {
			const took = spoken(now() - startedAt);
			const code = exitCodeOf(result);
			const status =
				code === undefined
					? `${result.isError ? "failed" : "finished"} after ${took}`
					: `exited ${code} after ${took}`;
			job.finish({
				summary: finishedSummary(
					label,
					status,
					firstText(result),
					fileName,
					keep,
				),
				...(result.isError ? { failed: true } : {}),
			});
		},
		(error: unknown) => {
			const said = error instanceof Error ? error.message : String(error);
			job.finish({
				summary: finishedSummary(
					label,
					`stopped after ${spoken(now() - startedAt)}`,
					said,
					fileName,
					keep,
				),
				failed: true,
			});
		},
	);

	return {
		content: [
			{
				type: "text",
				text: handOffText({
					jobId: job.id,
					background: call.background === true,
					afterMs: delay,
					output: latest,
					silentForMs: now() - lastOutputAt,
					holdsBack: holdsOutputBack(call.command),
				}),
			},
		],
		details: undefined,
	};
}

/** What the call answers once the command has moved to a job. */
function handOffText(handed: {
	jobId: string;
	background: boolean;
	afterMs: number;
	output: string;
	silentForMs: number;
	holdsBack: boolean;
}): string {
	const opening = handed.background
		? `Running as background command ${handed.jobId}.`
		: `Still running after ${spoken(handed.afterMs)}, so it now runs as background command ${handed.jobId}.`;
	const lines = [
		`${opening} Its result will arrive as a message of its own when it ends.`,
		"Carry on with work that does not depend on it. Until then, do not run it again, and do not run anything that needs its result or changes what it is working on.",
		// Killing the shell by hand left a grandchild nix build running on
		// 23 October, and the machine queue counted its place free.
		`To stop it, call the jobs tool's stop with ${handed.jobId} (load it with tool_search), which kills everything the command started; never kill its shell by hand, which leaves the command's children running. The person can stop it with /jobs.`,
	];
	if (handed.output.trim() !== "") {
		lines.push(
			`Last output, ${spoken(handed.silentForMs)} ago:`,
			lastLines(handed.output, HAND_OFF_LINES),
		);
	} else if (!handed.background) {
		lines.push(
			handed.holdsBack
				? "It has printed nothing. It pipes through tail or head, which holds everything back until it ends; pi already keeps the end of a command's output and saves the rest to a file, so let the output through next time."
				: "It has printed nothing yet.",
		);
	}
	return lines.join("\n");
}

/** What the job says once the command has ended. */
function finishedSummary(
	label: string,
	status: string,
	output: string,
	fileName: string,
	keep: (name: string, text: string) => string,
): string {
	const lines = [`\`${label}\` ${status}.`];
	const trimmed = output.replace(/\n+$/, "");
	if (trimmed === "") return lines[0] ?? "";
	const all = trimmed.split("\n");
	lines.push(lastLines(trimmed, FINISHED_LINES));
	// pi names its own file when it cut the output; otherwise keep it here.
	if (all.length > FINISHED_LINES && !/Full output: /.test(trimmed)) {
		lines.push(`Full output: ${keep(fileName, trimmed)}`);
	}
	return lines.join("\n");
}
