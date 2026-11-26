/**
 * What a hosted conversation's stop keeps, what its close for good ends,
 * and what a host restart would end of its background work. A stop short
 * of a close for good (a park, a host's stop, a release to another
 * holder, pi's replacement) keeps what its ended calls left running, as
 * plain pi does, noting it (left-running.ts) so every reap spares it for
 * a day; a close for good ends that too.
 */
import type { SessionStamp } from "../../lib/core/session/index.ts";
import { carryUnderWay } from "../../lib/internal/carry/under-way.ts";
import { carriedCalls } from "../../lib/internal/shell/kept.ts";
import { findJobHost } from "../../lib/jobs/host.ts";
import { type CarriedShells, STRAY_LOOK_MS } from "./carried-shells.ts";
import { isHeavy } from "./heavy.ts";
import { leftRunning, sparedUnder } from "./left-running.ts";
import type { EventBus } from "./pi-session.ts";
import {
	callsLeftRunning,
	linuxProcessTable,
	markedByConversation,
	type ProcessTable,
	REAP_WAITED,
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
	/**
	 * End what this host's dead predecessors' tools left running, held or
	 * not. One that waits, since what it spares failed to read, is tried
	 * again each STRAY_LOOK_MS until one doesn't: nothing else reaps the
	 * key whole while this host runs, so what a dead host left for a
	 * conversation this one never resumes would run on until the next
	 * start. Only a dead host's are ended, so a later try spares this
	 * host's own as the first did.
	 */
	reapEarlier(hostKey: string): Promise<void>;
	/**
	 * End what a conversation's tools left running, sparing what is carried
	 * or kept. Between `resuming` and `resumed`, the first reap of each
	 * conversation the start holds looks first at what one reading of the
	 * table, taken at the start's first such reap, named for it. A close's
	 * reap in `dropped` always reads the table for itself.
	 */
	reap(sessionId: string): Promise<void>;
	/**
	 * A start begins resuming the conversations it held, after
	 * `reapEarlier`: nothing of a held one runs in this host until pi builds
	 * it, which its first reap comes before, and the hosts whose tools left
	 * it processes have ended, so one reading of the table, however old,
	 * serves them all. That holds for processes marked honestly: this reap
	 * is tidying, never containment, since a tool may start one unmarked.
	 * A conversation the start doesn't hold (opened,
	 * adopted or pi's replacement) may have started tools since, so it
	 * reads the table for itself, as does every reap once a reading fails.
	 */
	resuming(held: Iterable<string>): void;
	/** The start is over: every reap reads the table for itself again. */
	resumed(): void;
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
	/** The folder what parks keep goes in at each use, rather than `stateDir`, as a child host keeps its own. */
	readonly keptIn?: () => string;
	readonly report: (error: unknown) => void;
	/**
	 * The process table every reap here reads, a conversation's, a
	 * start's of what an earlier host left, and a close's alike; Linux's
	 * /proc by default. A Mac has none, so none is reaped there.
	 */
	readonly table?: ProcessTable;
	/** Run `run` every `ms`, answering how to stop; an unreferenced interval by default. */
	readonly every?: (ms: number, run: () => void) => () => void;
}): StopKeeping {
	const { report } = options;
	const table = options.table ?? linuxProcessTable();
	// The start's one reading of the table, taken at the first reap of a
	// conversation it holds, and the held ones whose first reap hasn't had it.
	let start:
		| {
				scan?: Promise<Map<string, number[]>>;
				readonly unreaped: Set<string>;
				failed?: boolean;
		  }
		| undefined;
	// What parks kept of what ended calls left running is spared by every reap.
	const left = leftRunning(options);
	// Conversations the service is releasing to another holder, whose close keeps what parks kept.
	const handedOn = new Set<string>();

	async function reap(sessionId: string): Promise<void> {
		await reapAmong(sessionId, await startScanFor(sessionId));
	}

	async function reapAmong(
		sessionId: string,
		among: readonly number[] | undefined,
	): Promise<void> {
		const reaped = await reapToolChildren(
			sessionId,
			table,
			left.spared(await carriedCalls(), sessionId),
			among,
		);
		// A close for good reaps its conversation's tools only this once.
		if (reaped.waited) report(`${REAP_WAITED} of ${sessionId}`);
	}

	/**
	 * What the start's reading named for a conversation it holds, on its
	 * first reap of the start; nothing for any other, or once it has had
	 * it, when what pi built since may have started more.
	 */
	async function startScanFor(
		sessionId: string,
	): Promise<readonly number[] | undefined> {
		const current = start;
		if (!current?.unreaped.delete(sessionId)) return undefined;
		current.scan ??= markedByConversation(table);
		try {
			return (await current.scan).get(sessionId) ?? [];
		} catch (error) {
			// Said once, by whichever reap hears it first: this reap and every
			// one after read the table for themselves, as outside a start.
			if (!current.failed) {
				current.failed = true;
				current.unreaped.clear();
				report(
					new Error(
						"The start's one reading of the process table failed, so each reap reads it for itself",
						{ cause: error },
					),
				);
			}
			return undefined;
		}
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

	/** One reap of what dead hosts under the key left, answering whether it waited. */
	async function reapEarlierOnce(hostKey: string): Promise<boolean> {
		// The whole key's, so every child's notes too, not only this host's.
		const spared = await sparedUnder(options.stateDir, await carriedCalls(), {
			report,
		});
		const reaped = await reapLeftBehind(hostKey, table, spared);
		if (reaped.waited) report(`${REAP_WAITED} under ${hostKey}`);
		if (reaped.groups.length > 0 || reaped.pids.length > 0)
			report(
				`Ended what an earlier host's tools left running: groups ${reaped.groups.join(", ") || "none"}, processes ${reaped.pids.join(", ") || "none"}`,
			);
		return reaped.waited === true;
	}

	/** Try a start's reap that waited again each STRAY_LOOK_MS, one at a time, until one doesn't wait. */
	function retryEarlier(hostKey: string): void {
		const every =
			options.every ??
			((ms: number, run: () => void) => {
				const timer = setInterval(run, ms);
				timer.unref();
				return () => clearInterval(timer);
			});
		let trying = false;
		const stop = every(STRAY_LOOK_MS, () => {
			// A try still out when the next tick comes is let finish first.
			if (trying) return;
			trying = true;
			reapEarlierOnce(hostKey)
				.then((waited) => {
					if (!waited) stop();
				})
				.catch(report)
				.finally(() => {
					trying = false;
				});
		});
	}

	return {
		async reapEarlier(hostKey) {
			if (await reapEarlierOnce(hostKey)) retryEarlier(hostKey);
		},

		reap,

		resuming(held) {
			start = { unreaped: new Set(held) };
		},

		resumed() {
			start = undefined;
		},

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
			// as a running one's close ends it; released, it is kept. Either
			// way the start owes it no reap, so its close, or its first reap
			// once adopted back, reads the table for itself: a kept command may
			// have started more since the start's reading.
			start?.unreaped.delete(sessionId);
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

/**
 * The carry of a conversation's work a host restart would end, as a
 * line, or none. A carry ends its run first, so the conversation reads
 * as idle while it bundles, and its done file is written last: a restart
 * then loses the carry and leaves its node waiting
 * (lib/internal/carry/under-way.ts).
 */
export function carryEnds(sessionId: string): string[] {
	const to = carryUnderWay(sessionId);
	return to === undefined ? [] : [`a carry to ${to}`];
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
