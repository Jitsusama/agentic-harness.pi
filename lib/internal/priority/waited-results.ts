/**
 * Which background jobs' results a person waits on, so the run a result
 * starts keeps the typed mark (typed.ts) the run that started its job had.
 *
 * A person asks for something long, the agent hands it to a job, and
 * their run ends. The result comes back later as a message the harness
 * sends, which reads as nobody's, so its run went out in the shaper's
 * bulk class behind every agent's upload while the person waited on it
 * (B8RBNW, 15 November). A job knows the tool call it carried on for,
 * and a call made inside a typed run is the person's; that is the whole
 * link.
 *
 * A job's end is said on the bus just after its result is posted, and
 * the outbox may send the result at once, so either may come first: a
 * report seen before its job's end waits for it, until the run it
 * started begins. A result steered into a run already under way changes
 * nothing here; that run is marked or not by what started it.
 */

/** How many tool calls of typed runs it keeps, most of which never become jobs. */
export const CALLS_KEPT = 256;

/** A job's end, as much of it as says whose it was. */
interface Ended {
	readonly jobId: string;
	readonly toolCallId?: string;
}

/** Adds to a set that keeps only its newest `limit` entries. */
function keep(set: Set<string>, value: string, limit: number) {
	set.add(value);
	for (const oldest of set) {
		if (set.size <= limit) break;
		set.delete(oldest);
	}
}

/** Follows one conversation's jobs from the typed calls that started them. */
export function waitedResults(limit = CALLS_KEPT) {
	// Tool calls a typed run made, any of which may carry on as a job.
	const calls = new Set<string>();
	// Jobs those calls became, whose results are not yet reported.
	const waited = new Set<string>();
	// Jobs a report named before their end was heard, until a run begins.
	const reportedEarly = new Set<string>();
	return {
		/** A typed run made this tool call. */
		called(toolCallId: string) {
			keep(calls, toolCallId, limit);
		},
		/**
		 * A job ended; whether its report already arrived, so the run that
		 * report is starting is the person's.
		 */
		finished({ jobId, toolCallId }: Ended): boolean {
			if (toolCallId === undefined || !calls.delete(toolCallId)) return false;
			if (reportedEarly.delete(jobId)) return true;
			keep(waited, jobId, limit);
			return false;
		},
		/** A report of these jobs arrived; whether the person waits on one. */
		reported(jobIds: readonly string[]): boolean {
			let owed = false;
			for (const jobId of jobIds) {
				if (waited.delete(jobId)) owed = true;
				else keep(reportedEarly, jobId, limit);
			}
			return owed;
		},
		/** A run began: a report before it has started it, or never will. */
		began() {
			reportedEarly.clear();
		},
	};
}
