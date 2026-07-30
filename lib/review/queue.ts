/**
 * Where a change stands with a merge queue, and what that costs.
 *
 * This exists because the substrate had the refusal and not the fact. An
 * authoring intent could carry `enqueued: true` and be refused for it,
 * but nothing ever read the queue from a provider, so the gate was
 * unreachable and every mutation went through.
 */

/** How far along a queue a change is. */
export type QueuePosture = "unqueued" | "waiting" | "queued";

/** What the backend says about a change's place in a queue. */
export interface QueueState {
	posture: QueuePosture;
	/** Whether the backend is testing it alone rather than with others. */
	solo?: boolean;
	/** Place in the queue, 1-based, when the backend counts. */
	position?: number;
	/** What the backend said, verbatim, for a refusal to quote. */
	detail?: string;
}

/** A refusal, in the shape the authoring gate wants. */
export interface QueueRefusal {
	reason: string;
	instead: string;
}

/** `1st`, `2nd`, `3rd`, `4th`. */
function ordinal(n: number): string {
	const teen = n % 100;
	if (teen >= 11 && teen <= 13) return `${n}th`;
	const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th";
	return `${n}${suffix}`;
}

/**
 * Why a mutation should not happen right now, or nothing.
 *
 * Two hazards, deliberately answered separately, because they have
 * different fixes and a message covering both would name neither.
 *
 * A queued change ejects when it changes, and takes everything
 * speculatively batched with it. That is the expensive one, and it is
 * only expensive when the change is batched, so `solo` is respected: a
 * refusal that claims hundreds of jobs for a change being tested alone
 * teaches the reader to stop believing refusals.
 *
 * A waiting change has a subtler problem. The checks ran once, when it
 * was marked ready, and a later commit does not retrigger them. So a
 * mutation does not eject anything; it strands the change with results
 * that describe code nobody has now.
 */
export function queueRefusal(
	queue: QueueState | undefined,
	providerId: string,
): QueueRefusal | undefined {
	// Absent is unknown rather than queued. A provider with no queue must
	// not have every mutation refused on suspicion.
	if (queue === undefined || queue.posture === "unqueued") return undefined;

	const said = queue.detail ? ` The backend says: ${queue.detail}.` : "";

	if (queue.posture === "waiting") {
		return {
			reason: `This change is waiting on checks to merge on ${providerId}, and those checks ran once when it was marked ready. Changing it now does not run them again, so the results would describe code that no longer exists.${said}`,
			instead:
				"Cancel the merge, make the change, then re-run the checks and queue it again.",
		};
	}

	const place =
		queue.position === undefined
			? ""
			: ` It is ${ordinal(queue.position)} in line.`;
	const batch =
		queue.solo === true
			? ""
			: " Everything speculatively batched with it is ejected too, and re-running the checks for the rest is measured in hundreds of jobs.";

	return {
		reason: `This change is queued to merge on ${providerId}, and changing it now ejects it from the queue.${batch}${place}${said}`,
		instead:
			"Cancel the merge, make the change, and queue it again, or wait for it to land.",
	};
}
