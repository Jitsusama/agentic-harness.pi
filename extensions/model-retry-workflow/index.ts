/**
 * Model Retry Workflow: when a model call fails for a moment (a
 * timeout, a server error, an overloaded provider) and pi's own quick
 * retries run out, the session waits and asks again on a slower
 * schedule, rather than resting on an error nobody may see. It goes
 * on until a call answers, the person types or presses Escape, and a
 * reload or a host restart in the middle of a wait does not end it.
 *
 * Only a session somebody sits at retries: a subagent's run and a
 * print run end with their job, and whoever started them judges a
 * failure.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lastReply } from "../../lib/internal/errors/model-failure.ts";
import { isSubagent } from "../../lib/mesh/hand.ts";
import { createRetrier } from "./retry.ts";

export default function modelRetryWorkflow(pi: ExtensionAPI) {
	if (isSubagent()) return;
	const retrier = createRetrier(pi);

	// A reload or a restart ends the last load's timer; the session's own
	// record says whether it was waiting (record.ts).
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		retrier.resumed(ctx);
	});

	// A run can end more than once before it settles (pi's own retry, a
	// queued follow-up), so the last reply is kept until it does.
	pi.on("agent_end", async (event) => {
		retrier.ended(lastReply(event.messages));
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (!ctx.hasUI) return;
		retrier.settled(event.aborted, ctx);
	});

	pi.on("agent_start", async () => {
		retrier.started();
	});

	// Only the person's own typing starts the count again. A try is said
	// through pi as an extension's message, as a mesh message or a steer
	// is, and counting those as typing kept every try the first: one
	// session tried over 260 times in six hours without a network.
	pi.on("input", async (event) => {
		if (event.source !== "extension") retrier.typed();
		return { action: "continue" };
	});

	pi.on("session_shutdown", async () => {
		retrier.stop();
	});
}
