/**
 * Background jobs: the seam between work that runs on after its tool
 * returns and the host that says the result.
 *
 * A producer (the fleet, a review round) asks for the host with
 * `findJobHost`, starts a job, and calls `finish` when the work ends.
 * The host, `job-workflow`, owns the outbox that says the result to the
 * model at a safe moment, the job list, and stopping jobs when their
 * session ends. Neither imports the other.
 */

export {
	announceJobHost,
	type CarriedWork,
	findJobHost,
	JOBS_ASK,
	JOBS_FINISHED,
	JOBS_YIELD,
	type Job,
	type JobCarry,
	type JobFinished,
	type JobHold,
	type JobHost,
	type JobOutcome,
	type JobSpec,
	type JobStop,
	jobStopOf,
	jobStopReason,
	onJobFinished,
} from "./host.ts";
