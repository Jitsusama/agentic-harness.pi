/**
 * A background fleet carried through its session's move into a host:
 * its subagents run on, and the conversation that takes the session up
 * says the fleet's summary under the same job id and run id.
 *
 * Each subagent runs under a supervisor that writes its result to disk
 * whether or not anyone waits, and stops it once its parent is gone.
 * So the moving pi lets the fleet go with a carry (lib/jobs/host.ts):
 * the fleet no longer follows the job's signal, so the pi's end stops
 * nothing, and the run's `parent.json` says it is being handed on, for
 * as long as the move lasts (lib/subagent/handing.ts). The taker, a
 * host or the plain pi a failed move falls back to, answers
 * `jobs:take-up` for the kind, writes itself into `parent.json` as the
 * owner, and reads each subagent's result from disk as it lands.
 *
 * Nothing is lost quietly. A subagent its supervisor stopped because
 * nobody took the fleet up in time is said as cut off in the move, and
 * one whose supervisor went leaving no result as lost, each with its
 * last activity and its transcript. A fleet no conversation took up at
 * all is cut off as its owner gone by the sweep, which tells the
 * conversation when it comes back.
 *
 * Spend stays with the conversation: each subagent's run is recorded
 * once, by the process that sees it end, in the conversation it runs
 * in, which a move keeps under the same session id.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { recordRunEverywhere } from "../../lib/core/observability/recorder.ts";
import type { RunRecord } from "../../lib/core/observability/types.ts";
import {
	type TickedOwner,
	type TickFacts,
	tickFacts,
} from "../../lib/internal/process-ticks.ts";
import { isRecord } from "../../lib/internal/record.ts";
import { moveFolder } from "../../lib/internal/session/move.ts";
import type { CarriedWork, Job, JobCarry } from "../../lib/jobs/index.ts";
import { type Taking, takesUpCarried } from "../../lib/jobs/take-up.ts";
import { ReviewerArtifactsStore } from "../../lib/subagent/artifacts.ts";
import { createFleetLedger, whoIsWaiting } from "../../lib/subagent/fleet.ts";
import {
	handingNow,
	removeParent,
	writeParent,
} from "../../lib/subagent/handing.ts";
import { supervisorStanding } from "../../lib/subagent/lease.ts";
import { watchRun } from "../../lib/subagent/run-record.ts";
import {
	type FleetMember,
	memberRecord,
	readMember,
} from "./carried-member.ts";
import {
	aggregateUsage,
	type FleetSubagentResult,
	formatFleetSummary,
	locateArtifacts,
} from "./run.ts";

/** The kind a fleet's job and its carried work go by. */
export const FLEET_WORK = "subagent";

/** How often a taken-up fleet looks again at its subagents' results. */
export const FLEET_LOOK_MS = 2_000;

/** What a move carries of a fleet, as plain data the session's log holds. */
export interface CarriedFleet extends CarriedWork, FleetToCarry {
	readonly kind: typeof FLEET_WORK;
	/** The conversation that dispatched it, which takes it up. */
	readonly session: string;
	/** The subagents whose runs the moving pi already recorded. */
	readonly recorded: readonly string[];
}

/** A fleet as its dispatcher knows it, before anything is carried. */
export interface FleetToCarry {
	readonly runId: string;
	readonly members: readonly FleetMember[];
	/** When it was dispatched, in ms since the epoch. */
	readonly startedAt: number;
	/** The folder its supervisors keep its files under. */
	readonly runs: string;
	/** The folder its ledger record is kept in. */
	readonly fleets: string;
	/** The line its summary opens with: what it ran on. */
	readonly ranOn: string;
}

/** How a fleet running here can be let go to the session's next process. */
export interface FleetHandOver {
	/**
	 * The signal the fleet runs under: `signal`'s, until the fleet is
	 * handed on, after which nothing here stops it.
	 */
	follow(signal: AbortSignal): AbortSignal;
	/** The job's carry. */
	readonly carry: JobCarry;
	/** Whether it was handed on. */
	handedOn(): boolean;
	/**
	 * Record a subagent's run, as the dispatcher does when it ends here;
	 * once handed on, the taker records it instead.
	 */
	recordRun(record: RunRecord): void;
	/** It ended here, so there is nothing left to carry. */
	ended(): void;
}

/**
 * The hand-over of one fleet, dispatched by the conversation `session`;
 * one with no session can't be taken up, so it holds a move.
 */
export function fleetHandOver(
	fleet: FleetToCarry,
	session: string | undefined,
	folder: string = moveFolder(),
	record: (record: RunRecord) => void = recordRunEverywhere,
): FleetHandOver {
	let handed = false;
	let done = false;
	const recorded = new Set<string>();
	const runDir = new ReviewerArtifactsStore(fleet.runs).rootPaths(
		fleet.runId,
	).runDir;
	return {
		follow(signal) {
			const followed = new AbortController();
			const stop = () => {
				if (!handed) followed.abort(signal.reason);
			};
			if (signal.aborted) stop();
			else signal.addEventListener("abort", stop, { once: true });
			return followed.signal;
		},
		carry: {
			what: () =>
				session === undefined || done
					? undefined
					: {
							...fleet,
							kind: FLEET_WORK,
							session,
							recorded: [...recorded],
						},
			handed: () => {
				handed = true;
				if (session === undefined) return;
				try {
					writeParent(runDir, { handing: handingNow({ session, folder }) });
				} catch {
					// Its supervisors then stop it as this pi ends, and the taker
					// says each subagent as cut off in the move: nothing is lost
					// quietly, though it is lost.
				}
			},
		},
		handedOn: () => handed,
		recordRun(one) {
			if (handed) return;
			recorded.add(one.subagentId);
			record(one);
		},
		ended() {
			done = true;
		},
	};
}

/** Whether carried work is a fleet, as this version carries one. */
export function isCarriedFleet(work: CarriedWork): work is CarriedFleet {
	const { members, recorded } = work;
	return (
		work.kind === FLEET_WORK &&
		typeof work.runId === "string" &&
		typeof work.session === "string" &&
		typeof work.startedAt === "number" &&
		typeof work.runs === "string" &&
		typeof work.fleets === "string" &&
		typeof work.ranOn === "string" &&
		Array.isArray(members) &&
		members.every((one) => isRecord(one) && typeof one.id === "string") &&
		Array.isArray(recorded) &&
		recorded.every((one) => typeof one === "string")
	);
}

/** What taking a fleet up asks of the process it runs in. */
export interface FleetTakeUpFacts {
	/** Who is waiting here: this process, or this hosted conversation. */
	readonly owner: () => Promise<TickedOwner | undefined>;
	readonly ticks: TickFacts;
	readonly now: () => number;
	readonly pause: (ms: number) => Promise<void>;
	readonly record: (record: RunRecord) => void;
}

/** The machine's facts. */
const machine: FleetTakeUpFacts = {
	owner: () => whoIsWaiting(tickFacts),
	ticks: tickFacts,
	now: Date.now,
	pause: (ms) =>
		new Promise((resolve) => {
			setTimeout(resolve, ms);
		}),
	record: recordRunEverywhere,
};

/** Take up here any fleet a move carries into this session. */
export function takesUpCarriedFleets(
	bus: EventBus,
	facts: FleetTakeUpFacts = machine,
): () => void {
	return takesUpCarried(bus, FLEET_WORK, (work): Taking | undefined =>
		isCarriedFleet(work)
			? {
					start: (job) => {
						takeUpFleet(work, job, facts).catch((error: unknown) =>
							job.finish({
								summary: `Fleet ${work.runId} was carried here by a move, but following it failed: ${error instanceof Error ? error.message : String(error)}. Its subagents' results are under ${work.runs}.`,
								failed: true,
							}),
						);
					},
				}
			: undefined,
	);
}

/**
 * Follow a carried fleet to its end under `job`: become its owner, wait
 * for each subagent's result, record what each ran, and say the
 * summary, as the session that dispatched it would have.
 */
export async function takeUpFleet(
	fleet: CarriedFleet,
	job: Job,
	facts: FleetTakeUpFacts = machine,
): Promise<void> {
	const store = new ReviewerArtifactsStore(fleet.runs);
	const { runDir } = store.rootPaths(fleet.runId);
	const ledger = createFleetLedger(fleet.fleets);
	const owner = await facts.owner().catch(() => undefined);
	if (owner !== undefined) {
		writeParent(runDir, { owner });
		// Bookkeeping: parent.json already names who waits, for the sweep too.
		await ledger.handTo(fleet.runId, owner).catch(() => undefined);
	}
	const record = watchRun(
		{
			store: "fleet",
			artifacts: fleet.runs,
			runId: fleet.runId,
			kind: "fleet",
			parent: fleet.session,
			about: fleet.runId,
			since: new Date(fleet.startedAt),
		},
		fleet.members,
	);
	let stopped = job.signal.aborted;
	const stop = () => {
		stopped = true;
		store
			.requestRunCancellation(
				fleet.runId,
				`Stopped from the job list on ${new Date(facts.now()).toISOString()}.`,
			)
			.catch(() => undefined);
	};
	if (stopped) stop();
	else job.signal.addEventListener("abort", stop, { once: true });

	const results = new Map<string, FleetSubagentResult>();
	const already = new Set(fleet.recorded);
	for (;;) {
		for (const member of fleet.members) {
			if (results.has(member.id)) continue;
			const read = await readMember(store, fleet.runId, member.id, () =>
				supervisorStanding(
					store,
					fleet.runId,
					member.id,
					facts.ticks,
					facts.now(),
				),
			);
			if (read === undefined) continue;
			results.set(member.id, read.result);
			if (read.ran !== undefined && !already.has(member.id))
				facts.record(memberRecord(fleet, member, read.ran));
		}
		if (results.size === fleet.members.length) break;
		await facts.pause(FLEET_LOOK_MS);
	}
	await record.end();

	const ordered = fleet.members.flatMap((one) => {
		const result = results.get(one.id);
		return result === undefined ? [] : [result];
	});
	const totalUsage = aggregateUsage(ordered);
	const located = locateArtifacts(fleet.runs, {
		runId: fleet.runId,
		results: ordered,
		...(totalUsage ? { totalUsage } : {}),
		warnings: [],
	});
	const cutOff = stopped || ordered.some((one) => one.state === "cancelled");
	await (cutOff
		? ledger.cutOff(fleet.runId, "cancelled")
		: ledger.settle(fleet.runId)
	).catch(() => undefined);
	job.onDelivered(() => removeParent(runDir));
	// Said as the dispatching session says a fleet, failures and all.
	job.finish({
		summary: `${fleet.ranOn}\n\n${formatFleetSummary(located)}\n  carried here by a move; its subagents ran on through it`,
	});
}
