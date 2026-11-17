/**
 * What a hosted conversation's stop keeps, what its close for good ends,
 * and what a host restart would end of its background work. A stop short
 * of a close for good (a park, a host's stop, a release to another
 * holder, pi's replacement) keeps what its ended calls left running, as
 * plain pi does, noting it (left-running.ts) so every reap spares it for
 * a day; a close for good ends that too.
 */
import type { SessionStamp } from "../../lib/core/session/index.ts";
import { carriedCalls } from "../../lib/internal/shell/kept.ts";
import { findJobHost } from "../../lib/jobs/host.ts";
import type { CarriedShells } from "./carried-shells.ts";
import { isHeavy } from "./heavy.ts";
import { leftRunning } from "./left-running.ts";
import type { EventBus } from "./pi-session.ts";
import {
	callsLeftRunning,
	reapLeftBehind,
	reapToolChildren,
} from "./tool-children.ts";

/** How a conversation stopped, as its release left it. */
export interface Stopped {
	readonly ending?: SessionStamp["how"];
	readonly parking?: boolean;
	/**
	 * Its close hands it on, to pi's replacement in its seat or to another
	 * holder, so what its ended calls left is kept, as a stop keeps it.
	 */
	handsOn?: boolean;
}

/** A conversation's work as its job host holds it, while pi runs it. */
export interface Running {
	readonly runtime?: unknown;
	readonly bus: EventBus;
}

/** What a conversation's stop keeps and its close ends. */
export interface StopKeeping {
	/** End what this host's dead predecessors' tools left running, held or not. */
	reapEarlier(hostKey: string): Promise<void>;
	/** End what a conversation's tools left running, sparing what is carried or kept. */
	reap(sessionId: string): Promise<void>;
	/** Keep or end what a released conversation's ended calls left, by how it stopped, then reap the rest. */
	afterRelease(sessionId: string, record: Stopped): Promise<void>;
	/** The service is releasing a conversation to another holder, so its close keeps what parks kept. */
	handsOn(sessionId: string): void;
	/** A parked conversation is dropped: closed for good, what its parks kept ends with it; released, it is kept. */
	dropped(sessionId: string): Promise<void>;
}

/** Keep what stops leave in the engine's state folder, saying in the journal what it keeps and ends. */
export function stopKeeping(options: {
	readonly stateDir: string;
	readonly report: (error: unknown) => void;
}): StopKeeping {
	const { report } = options;
	// What parks kept of what ended calls left running is spared by every reap.
	const left = leftRunning(options);
	// Conversations the service is releasing to another holder, whose close keeps what parks kept.
	const handedOn = new Set<string>();

	async function reap(sessionId: string): Promise<void> {
		await reapToolChildren(sessionId, undefined, left.spared(carriedCalls()));
	}

	/** Spare no longer what a conversation closed for good kept, saying it in the journal; true when it kept any. */
	function endKept(sessionId: string): boolean {
		const ended = left.closed(sessionId);
		if (ended > 0)
			report(
				`Ending at ${sessionId}'s close what ${ended} ended command${ended === 1 ? "" : "s"} left`,
			);
		return ended > 0;
	}

	/** Note what a stopped conversation's ended calls left running, saying it in the journal. */
	async function keepLeftRunning(
		sessionId: string,
		stop: "park" | "stop",
	): Promise<void> {
		try {
			const marks = await callsLeftRunning(sessionId);
			if (marks.size === 0) return;
			left.note(sessionId, marks);
			report(
				`Kept running through ${sessionId}'s ${stop} what ${marks.size} ended command${marks.size === 1 ? "" : "s"} left`,
			);
		} catch (error) {
			// The stop goes on, and its reap ends them as before.
			report(error);
		}
	}

	return {
		async reapEarlier(hostKey) {
			const reaped = await reapLeftBehind(
				hostKey,
				undefined,
				left.spared(carriedCalls()),
			);
			if (reaped.groups.length > 0 || reaped.pids.length > 0)
				report(
					`Ended what an earlier host's tools left running: groups ${reaped.groups.join(", ") || "none"}, processes ${reaped.pids.join(", ") || "none"}`,
				);
		},

		reap,

		async afterRelease(sessionId, record) {
			// Any stop short of a close for good, a park, a host's stop, a release
			// or pi's replacement, keeps what its ended calls left running, as
			// plain pi does; a close for good ends what its parks kept too.
			if (handedOn.delete(sessionId)) record.handsOn = true;
			if (record.ending === "closed" && !record.handsOn) endKept(sessionId);
			else await keepLeftRunning(sessionId, record.parking ? "park" : "stop");
			// The signal kills a tool's own group; a descendant that left it ends here.
			await reap(sessionId);
		},

		handsOn(sessionId) {
			handedOn.add(sessionId);
		},

		async dropped(sessionId) {
			// Closed for good while parked, what its parks kept ends with it,
			// as a running one's close ends it; released, it is kept.
			if (!handedOn.delete(sessionId) && endKept(sessionId))
				try {
					await reap(sessionId);
				} catch (error) {
					// The close goes on; what the reap missed runs out the day it was kept for.
					report(error);
				}
		},
	};
}

/**
 * How much background work a conversation holds, as its job host counts
 * it; none while pi doesn't run it.
 */
export function backgroundIn(record: Running): number {
	if (!record.runtime) return 0;
	// job-workflow answers on the conversation's own bus; one from before
	// it could count says nothing, so it counts as holding work.
	const jobs = findJobHost(record.bus);
	return jobs ? (jobs.pending?.() ?? 1) : 0;
}

/**
 * What a host restart would end of a conversation's background work,
 * one line each, as its job host names it: every running job but a bash
 * call the restart can carry (fleets, codemode, review rounds, a call
 * that can't be kept), since only a call's shell is kept through the
 * host's stop. Where the host can keep none, bash calls too. Results
 * not yet said are carried in the conversation's log, so none holds it.
 * A job host from before `holds` says only how many it holds.
 */
export function restartEnds(
	record: Running,
	shells: CarriedShells,
	draining = false,
): string[] {
	if (!record.runtime) return [];
	const jobs = findJobHost(record.bus);
	if (!jobs) return [];
	if (!jobs.holds) {
		const pending = jobs.pending?.() ?? 1;
		return Array.from({ length: pending }, () => "a job");
	}
	const carriable = shells.keeps
		? (work: { kind: string }) => work.kind === "shell"
		: () => false;
	const held = jobs.holds(carriable);
	// A host draining holds its restart for a heavy run too, carried or not:
	// a stop that can't carry it, by hand or past systemd's limit, ends it.
	const heavy = draining
		? jobs
				.holds(() => false)
				.filter(
					(job) => isHeavy(job.label) && !held.some(({ id }) => id === job.id),
				)
		: [];
	return [...held, ...heavy].map(
		(job) => `${job.id} ${job.kind}: ${job.label}`,
	);
}

/** The heavy runs one conversation has going, carried or not, a line each. */
export function heavyIn(record: Running): string[] {
	if (!record.runtime) return [];
	const jobs = findJobHost(record.bus);
	if (!jobs?.holds) return [];
	return jobs
		.holds(() => false)
		.filter((job) => isHeavy(job.label))
		.map((job) => `${job.id} ${job.kind}: ${job.label}`);
}
