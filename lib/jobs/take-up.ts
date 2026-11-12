/**
 * Taking carried work up in the process a move carried it to.
 *
 * A move carries a running job as plain data in the session's log
 * (`CarriedWork`), and job-workflow takes the jobs up there. Only the
 * shell's jobs are job-workflow's to run again; any other kind belongs
 * to the extension that started it, which alone can rebuild what the
 * work needs, such as a change's binding or a round's record. So
 * job-workflow asks on the bus, as a producer asks for a host, and the
 * extension that knows the kind answers before `emit` returns. Every
 * extension's listeners are on by the time a session starts, so the
 * order they load in doesn't matter.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { CarriedWork, Job, JobCarry } from "./host.ts";

/**
 * Asked by the job host taking carried work up: the payload names the
 * work and a callback the extension that runs it answers into.
 */
export const JOBS_TAKE_UP = "jobs:take-up:v1";

/** How an extension runs carried work again, under the job it is given. */
export interface Taking {
	/** How the work can move on again, asked as any job's carry is. */
	readonly carry?: JobCarry;
	/** Run the work under its job, adopted under the id it had. */
	start(job: Job): void;
}

/** What `JOBS_TAKE_UP` carries. */
interface TakeUpAsk {
	readonly work: CarriedWork;
	readonly answer: (taking: Taking) => void;
}

/** Whether a payload is an ask to take work up, as this version says one. */
function isAsk(data: unknown): data is TakeUpAsk {
	if (typeof data !== "object" || data === null) return false;
	if (!("work" in data && "answer" in data)) return false;
	const { work, answer } = data;
	return (
		typeof answer === "function" &&
		typeof work === "object" &&
		work !== null &&
		"kind" in work &&
		typeof work.kind === "string"
	);
}

/**
 * Who will run carried work here, found now: the first extension to
 * answer for its kind, or nothing when none can.
 */
export function offerCarried(
	bus: Pick<EventBus, "emit">,
	work: CarriedWork,
): Taking | undefined {
	let found: Taking | undefined;
	bus.emit(JOBS_TAKE_UP, {
		work,
		answer: (taking: Taking) => {
			found ??= taking;
		},
	} satisfies TakeUpAsk);
	return found;
}

/**
 * Answer for carried work of one kind. `take` reads the work and says
 * how it runs, or nothing when the work is not what it can read, which
 * leaves it to be said as not taken up. Returns a disposer.
 */
export function takesUpCarried(
	bus: EventBus,
	kind: string,
	take: (work: CarriedWork) => Taking | undefined,
): () => void {
	return bus.on(JOBS_TAKE_UP, (data) => {
		if (!isAsk(data) || data.work.kind !== kind) return;
		const taking = take(data.work);
		if (taking) data.answer(taking);
	});
}
