/**
 * Handing a long tool call to the background.
 *
 * A tool call holds the session until it returns, and pi steers the
 * person's and the mesh's messages in only between calls. The session
 * logs show what that costs: on 11 November 270 codemode scripts and 67
 * review rounds held their turns past a minute, the longest for hours,
 * while bash, which already moved on after a minute, held none. A short
 * timeout is no answer, since it kills real work. So a call still
 * running after a while is not killed but moved: its lifetime passes
 * from the call to a job, the call returns saying so, and the job says
 * how the work ended once it has.
 *
 * The work is the tool's own, run under a signal this module owns. Until
 * the hand-off that signal follows the call's, so Escape stops the work
 * as it always has; after it, it follows the job's, so `/jobs`, the
 * jobs tool and the session ending do.
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	EventBus,
} from "@earendil-works/pi-coding-agent";
import { sessionEnv } from "../core/session/index.ts";
import { count, verb } from "../ui/count.ts";
import { firstText } from "../ui/tool-result.ts";
import { findJobHost } from "./host.ts";

/** How long a call may hold the session before it is handed off. */
export const HAND_OFF_MS = 60 * 1000;

/**
 * Whether a run in pi's `mode` ends once its prompts are done, as print
 * (`pi -p`) and JSON runs exit then. Work handed off there would be
 * stopped as the run ended, its result never heard, so it is not handed
 * off at all.
 */
export function endsWithItsPrompts(mode: string | undefined): boolean {
	return mode === "print" || mode === "json";
}

/** Lines of output the hand-off shows, so the model can see where it was. */
const HAND_OFF_LINES = 20;

/** Lines of output the finished job says before pointing at the rest. */
export const FINISHED_LINES = 40;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/** One tool call that may be handed off. */
export interface HandOff<T> {
	/** The job's kind, e.g. `shell`. */
	readonly kind: string;
	/** One line naming the work, on its job and in its result. */
	readonly label: string;
	/** What the model reads it as once moved, e.g. `background command`. */
	readonly noun: string;
	/** How to stop it, said after the job's id is named. */
	readonly stopping: (jobId: string) => string;
	/** What to say when it has shown nothing yet, if not the plain words. */
	readonly quiet?: string;
	/** The prefix its kept output's file is named with, e.g. `pi-bash`. */
	readonly filePrefix: string;
	/** The call being run, named on its job if it is handed off. */
	readonly toolCallId?: string;
	/** True to hand off at once; false or unset, after a while. */
	readonly background?: boolean;
	/** True when it must answer for itself: never handed off, even when asked. */
	readonly nested: boolean;
	readonly signal: AbortSignal | undefined;
	readonly onUpdate: AgentToolUpdateCallback<T> | undefined;
	readonly bus: EventBus;
	/** Run the work under the given signal, reporting progress as it comes. */
	readonly run: (
		signal: AbortSignal,
		onUpdate: AgentToolUpdateCallback<T>,
	) => Promise<AgentToolResult<T>>;
	readonly afterMs?: number;
	readonly now?: () => number;
	/** Keep a finished call's output somewhere the model can read it. */
	readonly keep?: (name: string, text: string) => string;
	/**
	 * The conversation calling, whose output files are named for it. A
	 * session's key is unique across processes, so the name needs no pid.
	 */
	readonly session: string;
}

/**
 * Write output to the conversation's temp directory. Read when the call
 * starts, since on a host only the call knows its conversation.
 */
function keepInTemp(session: string, prefix: string) {
	const dir = sessionEnv(session).get("TMPDIR") || tmpdir();
	return (name: string, text: string): string => {
		const resultPath = join(dir, `${prefix}-${name}.log`);
		writeFileSync(resultPath, text);
		return resultPath;
	};
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

/** The exit code a finished result reports, when it says one. */
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
 * Run a tool call, handing it to a job if it is still running when the
 * time comes. Answers with the call's own result when it ends first.
 */
export async function runOrHandOff<T>(
	call: HandOff<T>,
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
	const job = host.start({
		kind: call.kind,
		label: call.label,
		...(call.toolCallId !== undefined ? { toolCallId: call.toolCallId } : {}),
	});
	if (job.signal.aborted) owned.abort(job.signal.reason);
	else {
		job.signal.addEventListener("abort", () => owned.abort(job.signal.reason), {
			once: true,
		});
	}

	const keep = call.keep ?? keepInTemp(call.session, call.filePrefix);
	// Job ids start again in every conversation, several of which a host
	// runs in one process, and the file outlives them all.
	const fileName = `${call.session}-${startedAt}-${job.id}`;
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
					call.label,
					status,
					saidBy(result),
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
					call.label,
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
				text: handOffText(call, {
					jobId: job.id,
					afterMs: delay,
					output: latest,
					silentForMs: now() - lastOutputAt,
				}),
			},
		],
		details: undefined,
	};
}

/** What the call answers once the work has moved to a job. */
function handOffText<T>(
	call: HandOff<T>,
	handed: {
		jobId: string;
		afterMs: number;
		output: string;
		silentForMs: number;
	},
): string {
	const background = call.background === true;
	const opening = background
		? `Running as ${call.noun} ${handed.jobId}.`
		: `Still running after ${spoken(handed.afterMs)}, so it now runs as ${call.noun} ${handed.jobId}.`;
	const lines = [
		`${opening} Its result will arrive as a message of its own when it ends.`,
		"Carry on with work that does not depend on it. Until then, do not run it again, and do not run anything that needs its result or changes what it is working on.",
		call.stopping(handed.jobId),
	];
	if (handed.output.trim() !== "") {
		lines.push(
			`Last output, ${spoken(handed.silentForMs)} ago:`,
			lastLines(handed.output, HAND_OFF_LINES),
		);
	} else if (!background) {
		lines.push(call.quiet ?? "It has shown nothing yet.");
	}
	return lines.join("\n");
}

/**
 * Everything a result says, in words. A command's answer is one block;
 * a script's is pi's header and then each thing it said, so reading only
 * the first would drop the script's own output. A job's result is text,
 * so an image is named rather than carried.
 */
function saidBy(result: AgentToolResult<unknown>): string {
	const text = result.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
	const images = result.content.filter(
		(block) => block.type === "image",
	).length;
	if (images === 0) return text;
	const left = `${count(images, "image")} it showed ${verb(images, "is", "are")} left out, since a background result carries only text.`;
	return `${text.replace(/\n+$/, "")}\n${left}`;
}

/** What the job says once the work has ended. */
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
