/**
 * Handing a long command to the background.
 *
 * A bash call holds the session until the command ends, and the session
 * logs show what that costs: commands that ran for half an hour with
 * nothing on screen, until the person aborted them. So a command still
 * running after a minute moves to a job, as the shared hand-off
 * (`lib/jobs/hand-off.ts`) moves any tool's call.
 *
 * The wait is a minute, not the five it once was, and `background:
 * false` no longer means never: on 2026-10-25 sessions passed it on
 * 1,210 of 1,381 bash calls since 19:00, and the three that went deaf
 * to the orchestrator for 20 to 31 minutes had all passed it, two of
 * them while waiting in the machine queue.
 *
 * What is the shell's own is said here: a command is named by its first
 * line, and a command piped through tail or head is told why it showed
 * nothing.
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	EventBus,
} from "@earendil-works/pi-coding-agent";
import { runOrHandOff as handOff } from "../../lib/jobs/hand-off.ts";

/** Longest label a job is given, from the command's first line. */
const LABEL_CHARS = 60;

/** What running one bash call needs. */
export interface Call<T> {
	readonly command: string;
	/** The call being run, named on its job if it is handed off. */
	readonly toolCallId?: string;
	/** True to hand off at once; false or unset, after a while. */
	readonly background?: boolean;
	/**
	 * Made by a codemode script, or in a run that ends with its prompts,
	 * which need the real result: never handed off, even when asked.
	 */
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
	/** The conversation calling, whose output files are named for it. */
	readonly session: string;
}

/** A command, named in a line. */
export function labelOf(command: string): string {
	const line = command.trim().split("\n")[0]?.replace(/\s+/g, " ") ?? "";
	const more = command.trim().includes("\n") ? " ..." : "";
	if (line.length + more.length <= LABEL_CHARS) return `${line}${more}`;
	return `${line.slice(0, LABEL_CHARS - 3)}...`;
}

/** Whether the command holds its output back until it ends. */
function holdsOutputBack(command: string): boolean {
	return /\|\s*(tail|head)\b/.test(command);
}

/**
 * Run a bash call, handing it to a job if it is still running when the
 * time comes. Answers with the command's own result when it ends first.
 */
export async function runOrHandOff<T>(
	call: Call<T>,
): Promise<AgentToolResult<T | undefined>> {
	const { command, ...rest } = call;
	return await handOff({
		...rest,
		kind: "shell",
		label: labelOf(command),
		noun: "background command",
		filePrefix: "pi-bash",
		// Killing the shell by hand left a grandchild nix build running on
		// 23 October, and the machine queue counted its place free.
		stopping: (jobId) =>
			`To stop it, call the jobs tool's stop with ${jobId} (load it with tool_search), which kills everything the command started; never kill its shell by hand, which leaves the command's children running. The person can stop it with /jobs.`,
		quiet: holdsOutputBack(command)
			? "It has printed nothing. It pipes through tail or head, which holds everything back until it ends; pi already keeps the end of a command's output and saves the rest to a file, so let the output through next time."
			: "It has printed nothing yet.",
	});
}
