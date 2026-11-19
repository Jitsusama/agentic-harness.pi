/**
 * One realm-kind host's life: take its roster's lock, own its conversations,
 * load the engine, listen, then resume what it holds. Each step refuses
 * before the next starts, so a second host, an unreadable roster or an
 * unpatched pi never gets as far as a socket. Listening before the resumes
 * lets a window or a wake for one still to resume bring it forward, rather
 * than wait behind every other the host held.
 *
 * The host answers once it listens, and resumes what it holds only when
 * asked (`resume`), so whoever runs it can say it is ready first: on 19
 * November a resume of 95 under load outran systemd's start timeout at 90
 * of 95. Stopping begins no resume still to come, ends those under way,
 * parks every conversation as signalled and keeps every hold for the next
 * start.
 *
 * A host is one process for many conversations, so a stale-context
 * rejection left by one conversation's reload must not end the rest:
 * start sets the package's net for those before any conversation exists.
 */

import { join } from "node:path";
import { stateDir } from "../../lib/internal/paths.ts";
import {
	type Standing,
	type TickedOwner,
	tickedOwnerNow,
} from "../../lib/internal/process-ticks.ts";
import { spareStaleRejections } from "../../lib/internal/reload/stale-rejections.ts";
import { type ConversationIdentity, SessionHost } from "../engine/index.ts";
import { type HostKind, hostKey, hostSocketPath } from "./address.ts";
import {
	type ConversationEngine,
	conversationEvents,
	type HostBackend,
	heldOrder,
	hostBackend,
	type ResumeEnd,
	type ResumePhase,
	type Resuming,
	resumeHeld,
	type Unresumed,
} from "./backend.ts";
import type { ControlBackend } from "./dispatch.ts";
import { type AdmitAnother, hostRolloutGate } from "./rollout.ts";
import { openRoster, type RosterWait } from "./roster.ts";
import { listenControl, type ViewerBridge } from "./server.ts";

/**
 * A step a starting host has reached: waiting on a last host that still
 * holds the roster's lock, only when one does, then building its engine,
 * then each held conversation it resumes. A host is ready only after the
 * last, so these are how whoever waits on it knows a slow start still
 * moves.
 */
export type StartStep =
	| { readonly step: "roster"; readonly holder: number }
	| { readonly step: "engine" }
	| Resuming;

/** A running host, until stop. */
export interface ServingHost {
	readonly identity: ControlBackend["identity"];
	readonly path: string;
	/**
	 * Resume what the host holds, once; each later call answers the same.
	 * It rejects only as the start would fail, after every resume under
	 * way has ended, and the caller stops the host then.
	 */
	resume(): Promise<void>;
	/** The held conversations whose resume hasn't ended, by id. */
	resuming(): ReadonlySet<string>;
	/** Holds the engine could not resume at start, still held. */
	readonly unresumed: readonly Unresumed[];
	/** Holds dropped at start, by id, since their session files are gone. */
	readonly dropped: readonly string[];
	/**
	 * How many of those are still held and not running now, or left
	 * parked by a resume that failed once it had registered: one woken,
	 * adopted, closed or released since no longer counts.
	 */
	stillUnresumed(): number;
	/**
	 * How many it holds parked and not built, as one parked before a
	 * restart rests: held, not running, and not among those that failed.
	 */
	resting(): number;
	/** Each conversation the host runs, by id, with its state and when it last changed. */
	held(): readonly Pick<ConversationIdentity, "id" | "state" | "since">[];
	/**
	 * Say whether a restart of the host is coming. While it is, stopping
	 * tells every attached viewer the host is restarting before it closes
	 * the socket, so a viewer hears it only once systemd has the restart
	 * and just before the close it would otherwise take for the end.
	 */
	restartComing(coming: boolean): void;
	/** Whether a stop has begun, after which nothing it holds runs a turn. */
	stopping(): boolean;
	/** Close the socket, park every conversation and release the lock. */
	stop(): Promise<void>;
}

/**
 * Start a realm-kind host and resume what it holds, refusing at the first
 * step that can't be trusted; a resume that fails the start stops it.
 */
export async function serveHost(options: HostOptions): Promise<ServingHost> {
	const serving = await listenHost(options);
	try {
		await serving.resume();
	} catch (error) {
		await serving.stop().catch(options.report);
		throw error;
	}
	return serving;
}

/** How a host starts, what it serves and who hears its steps. */
export interface HostOptions {
	realm: string;
	kind: HostKind;
	engine: (host: SessionHost) => Promise<ConversationEngine>;
	report: (error: unknown) => void;
	/** Writes a line to the host's journal, as each conversation's end. */
	say?: (line: string) => void;
	viewer?: (host: SessionHost) => ViewerBridge;
	runtimeDir?: string;
	rosterDir?: string;
	registryDir?: string;
	owner?: TickedOwner;
	standing?: (owner: TickedOwner) => Promise<Standing>;
	/** How long and how a start waits on a lock another host holds. */
	rosterWait?: RosterWait;
	/** Where dropped stale-context rejections are written. */
	rejectionLog?: string;
	/**
	 * What a second conversation must pass, at open, adopt and resume: by
	 * default the rollout gate over the install this host runs from.
	 */
	rollout?: AdmitAnother;
	/**
	 * Hears each step of the start before it begins; a few resumes run at
	 * once, so a resume's step may begin before the last has finished.
	 */
	starting?: (step: StartStep) => Promise<void>;
	/** Hears each phase of a conversation being resumed as it ends. */
	mark?: (step: Resuming, phase: ResumePhase) => void;
	/** Hears a resume that `starting` heard end, resumed, parked or failed with why. */
	finished?: (step: Resuming, end: ResumeEnd, reason?: unknown) => void;
	/**
	 * How long a window's attach may wait for its answer, or go undrawn
	 * after it, before the journal says so: attach-waits.ts's ATTACH_SLOW_MS.
	 */
	attachSlowMs?: number;
}

/**
 * Start a realm-kind host as far as listening, refusing at the first step
 * that can't be trusted; it resumes what it holds once asked (`resume`).
 */
export async function listenHost(options: HostOptions): Promise<ServingHost> {
	const admitAnother = options.rollout ?? hostRolloutGate();
	const key = hostKey(options.realm, options.kind);
	spareStaleRejections(
		options.rejectionLog ??
			join(stateDir("host-service"), key, "stale-rejections.jsonl"),
	);
	const path = hostSocketPath(options.realm, options.kind, options.runtimeDir);
	const owner = options.owner ?? (await tickedOwnerNow());
	if (!owner) throw new Error("Host cannot name its own process");
	const roster = await openRoster({
		key,
		dir: options.rosterDir,
		owner,
		standing: options.standing,
		wait: {
			waiting: async ({ pid }) =>
				options.starting?.({ step: "roster", holder: pid }),
			...options.rosterWait,
		},
	});
	let host: SessionHost | undefined;
	let listener: Awaited<ReturnType<typeof listenControl>> | undefined;
	try {
		host = new SessionHost({ key, owner, registryDir: options.registryDir });
		await options.starting?.({ step: "engine" });
		const engine = await options.engine(host);
		// What wakes a parked conversation, once the host listens. A wake asked
		// before then waits for it: one still parked from before the start
		// (restsParked) wakes only so, as for a message sent while the host was
		// down. Once it stops a wake says why it can't, so a window that asked
		// says so rather than waiting on a wake that never comes.
		let wakes: HostBackend["wake"] | undefined;
		let listening = (_wake: HostBackend["wake"]): void => undefined;
		const listened = new Promise<HostBackend["wake"]>((resolve) => {
			listening = resolve;
		});
		// Before anything resumes, so a conversation that ends or becomes
		// another inside pi is never missed.
		engine.watch?.(
			conversationEvents({
				roster,
				report: options.report,
				...(options.say ? { say: options.say } : {}),
				wake: (sessionId) =>
					wakes ? wakes(sessionId) : listened.then((wake) => wake(sessionId)),
			}),
		);
		const order = heldOrder(roster);
		const identity = { key: host.key, owner: host.owner };
		const slowAfter =
			options.attachSlowMs === undefined
				? {}
				: { attachSlowMs: options.attachSlowMs };
		const backend = hostBackend({
			identity,
			host,
			roster,
			engine,
			admitAnother,
			held: order,
			...(options.say ? { say: options.say } : {}),
			...slowAfter,
		});
		const control = await listenControl({
			path,
			backend,
			viewer: options.viewer?.(host),
			report: options.report,
			...(options.say ? { say: options.say } : {}),
			...slowAfter,
		});
		listener = control;
		wakes = backend.wake;
		listening(backend.wake);
		const running = host;
		let stopping: Promise<void> | undefined;
		let restarting = false;
		let unresumed: readonly Unresumed[] = [];
		let dropped: readonly string[] = [];
		// Every hold is still to resume until its turn ends, so none is
		// counted as parked before its resume has looked at it.
		const pending = new Set(roster.entries().map((e) => e.sessionId));
		let resumes: Promise<void> | undefined;
		const resume = () => {
			resumes ??= resumeHeld({
				roster,
				engine,
				admitAnother,
				halted: () => stopping !== undefined,
				settled: (sessionId) => pending.delete(sessionId),
				starting: options.starting,
				mark: options.mark,
				finished: options.finished,
				order,
			}).then(
				(held) => {
					unresumed = held.unresumed;
					dropped = held.dropped;
					for (const { reason } of held.unresumed) options.report(reason);
				},
				(error: unknown) => {
					pending.clear();
					throw error;
				},
			);
			return resumes;
		};
		return {
			identity,
			path,
			resume,
			resuming: () => pending,
			get unresumed() {
				return unresumed;
			},
			get dropped() {
				return dropped;
			},
			stillUnresumed: () => {
				const live = new Map(running.list().map((c) => [c.id, c.state]));
				const held = new Set(roster.entries().map((e) => e.sessionId));
				return unresumed.filter(({ sessionId }) => {
					const state = live.get(sessionId);
					return held.has(sessionId) && (state ?? "parked") === "parked";
				}).length;
			},
			resting: () => {
				const live = new Set(running.list().map(({ id }) => id));
				const failed = new Set(unresumed.map(({ sessionId }) => sessionId));
				return roster
					.entries()
					.filter(
						({ sessionId }) =>
							!live.has(sessionId) &&
							!failed.has(sessionId) &&
							!pending.has(sessionId),
					).length;
			},
			held: () => running.list(),
			restartComing: (coming) => {
				restarting = coming;
			},
			stopping: () => stopping !== undefined,
			stop() {
				stopping ??= (async () => {
					wakes = () =>
						Promise.reject(
							new Error(
								"the host is stopping, and takes the conversation up again as it starts",
							),
						);
					if (restarting) await control.restarting();
					await control.close();
					// Those under way end first, so each is parked with the rest
					// rather than built in a host disposed under it; a resume's own
					// failure is the start's to say, not the stop's.
					await resumes?.catch(() => undefined);
					// A wake already resuming finishes first, so it is parked with
					// the rest rather than left running in a host disposed under it.
					await backend.settled();
					// A restart's parks carry each conversation's bash calls, which
					// are then kept out of the host's stop for the next host. Any
					// other stop carries them too where the engine can keep them:
					// on 17 November an outside stop ended four suites whose
					// commands could have run on.
					const carrying = restarting || (engine.carries?.() ?? false);
					await park(running, restarting, carrying);
					if (carrying) await engine.keepCarried?.();
					running.dispose();
					await roster.close();
				})();
				return stopping;
			},
		};
	} catch (error) {
		await listener?.close().catch(options.report);
		if (host) {
			await park(host).catch(options.report);
			// A conversation that would not park keeps the host installed; the
			// start error, not that, is what the caller must see.
			try {
				host.dispose();
			} catch (disposal) {
				options.report(disposal);
			}
		}
		await roster.close();
		throw error;
	}
}

/**
 * Park every conversation `host` holds, telling each the host restarts
 * when it does, and to carry its bash calls when the stop carries them.
 */
async function park(
	host: SessionHost,
	restarting = false,
	carrying = restarting,
): Promise<void> {
	const why = restarting ? "host restarting" : "host stopped";
	const results = await Promise.allSettled(
		host.list().map(({ id }) => host.stop(id, why, carrying)),
	);
	const failed = results.find((result) => result.status === "rejected");
	if (failed?.status === "rejected") throw failed.reason;
}
