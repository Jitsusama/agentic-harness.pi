/**
 * Whether a session could end now without losing anything of its own.
 *
 * Ending a pi ends what runs in it: a run under way is cut short, and a
 * background job (a bash command handed off, a fleet, a review round)
 * dies with the process, as do messages queued for its next turn, a
 * prompt open for its person and words typed in its editor and not yet
 * sent. None of that is in its presence, so only the session itself can
 * say it is free. Parking asks this before it parks (park.ts), and a
 * move asks it before the session ends for a host to take it up
 * (move.ts). A move hands on what can be carried (job-workflow's
 * moved.ts), so it asks which jobs hold, and says each by kind and id.
 */

import type { JobHold } from "../../jobs/index.ts";

/** What a session holds that ending it now would lose. */
export interface Holding {
	/** Nothing runs, retries or waits to continue (pi's `isIdle`). */
	readonly agentIdle: boolean;
	/** Messages wait to be delivered to it. */
	readonly pendingMessages: boolean;
	/** Background jobs running, or finished and not yet said. */
	readonly jobs: number;
	/** The jobs that hold, named, when whoever asks can say which. */
	readonly heldBy?: readonly JobHold[];
	/** A prompt is open for its person. */
	readonly prompting: boolean;
	/** Text typed in its editor and not yet sent. */
	readonly typed: boolean;
}

/** What holds this session, or nothing when it could end now. */
export function whatHolds(at: Holding): string | undefined {
	if (!at.agentIdle) return "a run is under way";
	if (at.pendingMessages) return "messages wait for it";
	if (at.jobs > 0)
		return at.heldBy?.length ? jobsOut(at.heldBy) : "background jobs are out";
	if (at.prompting) return "a prompt is open";
	if (at.typed) return "text is typed and unsent";
	return undefined;
}

/** What each kind of job is called where a hold names it, one and several. */
const KINDS: Readonly<Record<string, readonly [string, string]>> = {
	shell: ["a command", "commands"],
	subagent: ["a fleet", "fleets"],
	review: ["a review watch", "review watches"],
	"model-retry": ["a model retry", "model retries"],
	reload: ["a reload", "reloads"],
};

/** `count` jobs of `kind`, as a hold names them: `a fleet`, `2 commands`. */
function kindOf(kind: string, count: number): string {
	const [one, several] = KINDS[kind] ?? [`a ${kind} job`, `${kind} jobs`];
	return count === 1 ? one : `${count} ${several}`;
}

/**
 * The jobs that hold, by kind and id, as /host and a wave print them:
 * `a fleet is out (j3: k7-read)`.
 */
export function jobsOut(holds: readonly JobHold[]): string {
	const counts = new Map<string, number>();
	for (const hold of holds)
		counts.set(hold.kind, (counts.get(hold.kind) ?? 0) + 1);
	const kinds = [...counts].map(([kind, count]) => kindOf(kind, count));
	const named = holds.map((hold) => `${hold.id}: ${hold.label}`).join("; ");
	const which =
		kinds.length === 1
			? (kinds[0] ?? "")
			: `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1) ?? ""}`;
	return `${which} ${holds.length === 1 ? "is" : "are"} out (${named})`;
}
