/**
 * Job workflow extension: hosts background jobs and says each one's
 * result to the model when the session can take it.
 *
 * A producer finds the host over the bus (`lib/jobs`), starts a job,
 * and finishes it when the work ends. The result waits in the outbox
 * until no run, compaction or submitted prompt is under way, and goes
 * out as a prompt of its own. `/jobs` lists what is running and stops
 * one for the person; the deferred `jobs` tool does the same for the
 * agent. A reload hands the jobs to the runtime it starts, still running;
 * any other end of the session stops them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showJobs } from "./command.ts";
import { type JobSession, openSession } from "./lifecycle.ts";
import { type ShownReports, shownReports } from "./shown.ts";
import { registerJobsTool } from "./tool.ts";

/** The text of a user message, however pi carried it. */
function textOf(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	if (!("role" in message) || message.role !== "user") return undefined;
	if (!("content" in message)) return undefined;
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	return content
		.map((part: unknown) =>
			typeof part === "object" &&
			part !== null &&
			"text" in part &&
			typeof part.text === "string"
				? part.text
				: "",
		)
		.join("");
}

/**
 * The text of every user message in a session's history: none when it
 * can't be read, since that only costs one repeat a turn.
 */
function* userTexts(ctx: {
	sessionManager?: { getBranch?(): readonly unknown[] };
}): Generator<string> {
	let branch: readonly unknown[];
	try {
		branch = ctx.sessionManager?.getBranch?.() ?? [];
	} catch {
		return;
	}
	for (const entry of branch) {
		if (typeof entry !== "object" || entry === null) continue;
		if (!("message" in entry)) continue;
		const text = textOf(entry.message);
		if (text !== undefined) yield text;
	}
}

export default function jobWorkflow(pi: ExtensionAPI) {
	let session: JobSession | undefined;
	let shown: ShownReports = shownReports([]);

	pi.on("session_start", (event, ctx) => {
		session?.close();
		session = openSession(pi, ctx, event.reason);
		shown = shownReports(userTexts(ctx));
	});

	pi.on("session_shutdown", (event) => {
		if (event.reason === "reload") session?.park();
		else session?.close();
		session = undefined;
	});

	// A prompt typed during a run is queued by pi, not submitted; the
	// outbox tells the two apart by whether the session is idle.
	pi.on("input", (event) => {
		// A report already shown, sent again by a runtime pi left running
		// (see shown.ts): dropped, so it costs no turn.
		if (shown.again(event.text)) return { action: "handled" as const };
		session?.outbox.promptSubmitted();
		return undefined;
	});

	pi.on("agent_start", () => session?.outbox.runStarted());

	pi.on("agent_settled", () => session?.outbox.runSettled());

	pi.on("message_end", (event) => {
		const text = textOf(event.message);
		if (text === undefined) return;
		shown.add(text);
		session?.seen(text);
	});

	pi.registerCommand("jobs", {
		description: "List background jobs, and stop one",
		handler: (_args, ctx) => showJobs(session?.jobs, ctx),
	});

	registerJobsTool(pi, () => session?.jobs);
}
