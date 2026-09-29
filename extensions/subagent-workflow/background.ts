/**
 * A fleet run in the background: the call returns at once, the board
 * stays up above the editor, and the fleet's summary is said through
 * the job host when it ends.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { findJobHost, type Job } from "../../lib/jobs/index.ts";
import { count } from "../../lib/ui/count.ts";

/** What the fleet hands back, as far as its summary goes. */
interface FleetAnswer {
	readonly content: readonly { readonly text: string }[];
}

/**
 * Start the job a background fleet runs under, or refuse when no host
 * could say its result, since that fleet's answer would go nowhere.
 */
export function startFleetJob(bus: EventBus, runId: string, size: number): Job {
	const host = findJobHost(bus);
	if (!host) {
		throw new Error(
			"A background fleet needs the job-workflow extension to say its result, and it is not loaded. Run the fleet without background, or load job-workflow.",
		);
	}
	return host.start({
		kind: "subagent",
		label: `${count(size, "subagent")} in ${runId}`,
	});
}

/**
 * Say the fleet's summary through its job when it ends, and take the
 * board down once that summary is in the session, or at once when the
 * job was stopped with nobody left to say it to.
 */
export function finishInBackground(
	job: Job,
	fleet: Promise<FleetAnswer>,
	board: { close(): void },
	runId: string,
): void {
	const takeDown = () => {
		try {
			board.close();
		} catch {
			// The session that drew the board has ended, and its screen
			// with it: there is nothing left to take down.
		}
	};
	job.onDelivered(takeDown);
	fleet
		.then(
			(answer) =>
				job.finish({
					summary: answer.content.map((part) => part.text).join("\n"),
				}),
			(error: unknown) =>
				job.finish({
					summary: `Fleet ${runId} did not finish: ${error instanceof Error ? error.message : String(error)}`,
					failed: true,
				}),
		)
		.finally(() => {
			if (job.signal.aborted) takeDown();
		});
}

/** What the model is told as the call returns. */
export function startedAnswer(job: Job, runId: string, size: number) {
	return {
		content: [
			{
				type: "text" as const,
				text: `Started ${count(size, "subagent")} in the background as job ${job.id} (fleet ${runId}). The result arrives on its own as a message once the fleet ends, so do not poll or wait for it; carry on with other work. The person can stop it with /jobs or from its board.`,
			},
		],
		details: { ok: true, background: true, runId, jobId: job.id },
	};
}
