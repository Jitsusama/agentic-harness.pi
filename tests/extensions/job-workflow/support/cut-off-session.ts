/**
 * A session started on the job workflow with just enough of pi for its
 * end and its return, and the log entries a cut-off leaves.
 */

import type { EventEmitter } from "node:events";
import {
	createEventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { CUT_OFF_ENTRY } from "../../../../extensions/job-workflow/cut-off.ts";
import jobWorkflow from "../../../../extensions/job-workflow/index.ts";
import { withSession } from "../../../../lib/core/session/index.ts";
import { REFUSED_RUN_FIELD } from "../../../../lib/internal/session/cut-off-record.ts";

/** When the entries here say they were written. */
export const AT = "2026-10-24T17:54:34.617Z";

/** The timers the carried run's wait uses, faked alone. */
export const TIMEOUTS: ("setTimeout" | "clearTimeout")[] = [
	"setTimeout",
	"clearTimeout",
];

/** A message entry of `role`, with `extra` on the message. */
export const message = (role: string, extra: Record<string, unknown> = {}) => ({
	type: "message",
	timestamp: AT,
	message: { role, content: [{ type: "text", text: "x" }], ...extra },
});

/** The record a session's end leaves, holding `data`. */
export const ended = (data: unknown) => ({
	type: "custom",
	customType: CUT_OFF_ENTRY,
	timestamp: AT,
	data,
});

/** An answer that ended in an error, as a failed run's does. */
export const aborted = message("assistant", {
	stopReason: "error",
	errorMessage: "This operation was aborted",
});

/**
 * The answer a host ends a run with when durable refuses it, busy with
 * the carried run: hosted-agent.ts's `fail`, marked as the host's own.
 * Its words are none durable says, since the mark alone tells.
 */
export const refused = message("assistant", {
	stopReason: "error",
	errorMessage: "durable said no in words of its own",
	[REFUSED_RUN_FIELD]: true,
});

/**
 * The same answer as a host wrote it before it marked one, known only
 * by durable's `ConversationBusy` words.
 */
export const refusedUnmarked = message("assistant", {
	stopReason: "error",
	errorMessage: "Conversation c1 is busy",
});

/** The result a host gives the tool call a kill cut, as it carries the run on. */
export const interrupted = message("toolResult", { isError: true });

/** A log a kill left mid-run, ending on a tool's result with no record. */
export function killedLog(): unknown[] {
	return [
		message("user"),
		message("assistant", { stopReason: "toolUse" }),
		message("toolResult"),
	];
}

/** What a session is told when its carried run ended in an error. */
export const FAILED_TEXT =
	/Its host carried the run on, and it ended in an error/;

/** A session on the job workflow, as `activate` starts one. */
export type CutOffSession = ReturnType<typeof activate>;

/** Just enough of pi and a session for the end and the restore. */
export function activate(branch: unknown[], signals: EventEmitter, id = "s1") {
	const handlers = new Map<string, ((e: unknown, c: unknown) => unknown)[]>();
	const events = createEventBus();
	const said: string[] = [];
	const appended: { type: string; data: unknown }[] = [];
	const session = { busy: false };
	const pi = {
		events,
		on: (name: string, handler: (e: unknown, c: unknown) => unknown) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand: () => {},
		registerTool: () => {},
		sendUserMessage: (text: string) => said.push(text),
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	};
	const ctx = {
		hasUI: true,
		isIdle: () => !session.busy,
		sessionManager: { getBranch: () => branch, getSessionId: () => id },
		ui: {
			setStatus: () => {},
			theme: { fg: (_colour: string, text: string) => text },
			notify: () => {},
		},
	};
	jobWorkflow(pi as unknown as ExtensionAPI, { signals });
	const fire = async (name: string, event: unknown = {}) => {
		// Inside its conversation, as a host runs every hook.
		for (const handler of handlers.get(name) ?? [])
			await withSession(id, () => handler(event, ctx));
	};
	return { events, said, appended, session, fire, branch };
}

/**
 * Let `pi`'s newest notice reach its session, as pi's `message_end`
 * does, so the outbox would send another at once rather than holding it.
 */
export async function noticeSeen(pi: CutOffSession): Promise<void> {
	const content = [{ type: "text", text: pi.said.at(-1) }];
	await pi.fire("message_end", { message: { role: "user", content } });
}

/** Start the carried run in `pi`, adding `entries` to its log. */
export async function carriedRunStarts(
	pi: CutOffSession,
	...entries: unknown[]
): Promise<void> {
	pi.session.busy = true;
	await pi.fire("agent_start");
	for (const entry of entries) if (entry) pi.branch.push(entry);
}

/** Run the carried run in `pi`, adding `entries` to its log, then settle it. */
export async function carriedRun(
	pi: CutOffSession,
	first: unknown,
	second: unknown,
	settled: { aborted?: boolean } = {},
): Promise<void> {
	await carriedRunStarts(pi, first, second);
	pi.session.busy = false;
	await pi.fire("agent_settled", settled);
}
