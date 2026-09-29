/**
 * Job workflow extension: hosts background jobs and says each one's
 * result to the model when the session can take it.
 *
 * A producer finds the host over the bus (`lib/jobs`), starts a job,
 * and finishes it when the work ends. The result waits in the outbox
 * until no run, compaction or submitted prompt is under way, and goes
 * out as a prompt of its own. `/jobs` lists what is running and stops
 * one.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showJobs } from "./command.ts";
import { type JobSession, openSession } from "./lifecycle.ts";

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

export default function jobWorkflow(pi: ExtensionAPI) {
	let session: JobSession | undefined;

	pi.on("session_start", (_event, ctx) => {
		session?.close();
		session = openSession(pi, ctx);
	});

	pi.on("session_shutdown", () => {
		session?.close();
		session = undefined;
	});

	// A prompt typed during a run is queued by pi, not submitted; the
	// outbox tells the two apart by whether the session is idle.
	pi.on("input", () => session?.outbox.promptSubmitted());

	pi.on("agent_start", () => session?.outbox.runStarted());

	pi.on("agent_settled", () => session?.outbox.runSettled());

	pi.on("message_end", (event) => {
		const text = textOf(event.message);
		if (text !== undefined) session?.seen(text);
	});

	pi.registerCommand("jobs", {
		description: "List background jobs, and stop one",
		handler: (_args, ctx) => showJobs(session?.jobs, ctx),
	});
}
