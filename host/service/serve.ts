/**
 * One realm-kind host's life: take its roster's lock, own its conversations,
 * load the engine, listen, then resume what it holds. Each step refuses
 * before the next starts, so a second host, an unreadable roster or an
 * unpatched pi never gets as far as a socket. Listening before the resumes
 * lets a window or a wake for one still to resume bring it forward, rather
 * than wait behind every other the host held.
 *
 * The start is done, and the host ready, only once the last has resumed. Stopping parks every
 * conversation as signalled and keeps every hold for the next start.
 *
 * A host is one process for many conversations, so a stale-context
 * rejection left by one conversation's reload must not end the rest:
 * start sets the package's net for those before any conversation exists.
 */

import { dirname, join } from "node:path";
import type { RosterEntry } from "../../lib/core/session/roster.ts";
import { stateDir } from "../../lib/internal/paths.ts";
import {
	type Standing,
	type TickedOwner,
	tickedOwnerNow,
} from "../../lib/internal/process-ticks.ts";
import { spareStaleRejections } from "../../lib/internal/reload/stale-rejections.ts";
import {
	type ConversationIdentity,
	type HostChanges,
	SessionHost,
} from "../engine/index.ts";
import { type HostKind, hostKey, hostSocketPath } from "./address.ts";
import {
	type ConversationEngine,
	type HostBackend,
	hostBackend,
	type StartPhase,
	type Unresumed,
} from "./backend.ts";
import { type HostedChildren, hostChildren } from "./child-hosting.ts";
import type { ChildPolicy } from "./child-policy.ts";
import { slotFolder, type Units } from "./child-units.ts";
import { conversationEvents } from "./conversation-events.ts";
import type { ControlBackend } from "./dispatch.ts";
import {
	heldOrder,
	type ResumeEnd,
	type Resuming,
	resumeHeld,
} from "./resume-held.ts";
import { type AdmitAnother, hostRolloutGate } from "./rollout.ts";
import { openRoster, type RosterWait } from "./roster.ts";
import {
	listenControl,
	type ViewerBridge,
	type WatchBridge,
} from "./server.ts";

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
	/** How many conversations it holds run in processes of their own. */
	inChildren?(): number;
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

/** Start a realm-kind host, refusing at the first step that can't be trusted. */
export async function serveHost(options: {
	realm: string;
	kind: HostKind;
	engine: (host: SessionHost) => Promise<ConversationEngine>;
	report: (error: unknown) => void;
	/** Writes a line to the host's journal, as each conversation's end. */
	say?: (line: string) => void;
	viewer?: (host: SessionHost) => ViewerBridge;
	/** Whether a window views a conversation now, as the screens say. */
	viewed?: (sessionId: string) => boolean;
	runtimeDir?: string;
	/** The socket to listen on, rather than the realm-kind host's own, as a child's slot names. */
	socketPath?: string;
	rosterDir?: string;
	/**
	 * What the roster holds in place of its file's entries, written once its
	 * lock is taken, as a child's slot names the one it holds.
	 */
	rosterSeed?: readonly RosterEntry[];
	registryDir?: string;
	/** Hears each change the host publishes, as a child follows its one conversation. */
	changes?: HostChanges;
	/** What a watch follows; without one, a watch is refused. */
	watch?: WatchBridge;
	/** Hears a conversation becoming another inside pi, before the roster says so. */
	becoming?: (previousId: string, nextId: string) => void;
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
	 * Whether a held conversation was woken from a rest someone else kept,
	 * so the start resumes it as woken rather than resting it again.
	 */
	woken?: (entry: RosterEntry) => boolean;
	/**
	 * Hears each step of the start before it begins; a few resumes run at
	 * once, so a resume's step may begin before the last has finished.
	 */
	starting?: (step: StartStep) => Promise<void>;
	/** Hears each phase of a conversation being resumed as it ends. */
	mark?: (step: Resuming, phase: StartPhase) => void;
	/** Hears a resume that `starting` heard end, resumed, parked or failed with why. */
	finished?: (step: Resuming, end: ResumeEnd, reason?: unknown) => void;
	/**
	 * How long a window's attach may wait for its answer, or go undrawn
	 * after it, before the journal says so: attach-waits.ts's ATTACH_SLOW_MS.
	 */
	attachSlowMs?: number;
	/**
	 * Where conversations may run in a process each: the units that start
	 * them, and the policy, read for the host's key, saying which move.
	 * Without it, or while the policy moves none, this host runs them all.
	 */
	children?: {
		units: Units;
		policy: (key: string) => Promise<ChildPolicy>;
	};
}): Promise<ServingHost> {
	const admitAnother = options.rollout ?? hostRolloutGate();
	const key = hostKey(options.realm, options.kind);
	spareStaleRejections(
		options.rejectionLog ??
			join(stateDir("host-service"), key, "stale-rejections.jsonl"),
	);
	const path =
		options.socketPath ??
		hostSocketPath(options.realm, options.kind, options.runtimeDir);
	const owner = options.owner ?? (await tickedOwnerNow());
	if (!owner) throw new Error("Host cannot name its own process");
	const roster = await openRoster({
		key,
		dir: options.rosterDir,
		owner,
		standing: options.standing,
		...(options.rosterSeed ? { seed: options.rosterSeed } : {}),
		wait: {
			waiting: async ({ pid }) =>
				options.starting?.({ step: "roster", holder: pid }),
			...options.rosterWait,
		},
	});
	let host: SessionHost | undefined;
	let listener: Awaited<ReturnType<typeof listenControl>> | undefined;
	let children: HostedChildren | undefined;
	try {
		host = new SessionHost({
			key,
			owner,
			registryDir: options.registryDir,
			...(options.changes ? { changes: options.changes } : {}),
			...(options.viewed ? { viewed: options.viewed } : {}),
		});
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
		const events = conversationEvents({
			roster,
			report: options.report,
			...(options.say ? { say: options.say } : {}),
			wake: (sessionId) =>
				wakes ? wakes(sessionId) : listened.then((wake) => wake(sessionId)),
		});
		const { becoming } = options;
		// The backend, once it exists, hears each conversation that became
		// another, so a repeat of the open that made it answers with that one;
		// one that became another sooner was opened by no request it holds.
		let succeeded: HostBackend["became"] | undefined;
		engine.watch?.({
			...events,
			async became(previousId, next) {
				becoming?.(previousId, next.sessionId);
				await events.became(previousId, next);
				succeeded?.(previousId, next.sessionId);
			},
		});
		if (options.children) {
			const policy = await options.children.policy(key);
			try {
				children = hostChildren({
					key,
					// Beside the socket, in the runtime folder it was checked under.
					folder: slotFolder(dirname(dirname(path)), key),
					units: options.children.units,
					policy,
					roster,
					restsParked: (entry) => engine.restsParked?.(entry) ?? false,
					// A child's conversation that became another is told the backend
					// as one the host runs is, so a repeat names the one now.
					became: (previousId, nextId) => succeeded?.(previousId, nextId),
					report: options.report,
					...(options.say ? { say: options.say } : {}),
				});
			} catch (error) {
				// A runtime folder too long for a child's socket moves nothing:
				// the host runs every conversation itself, as with no policy.
				policy.close();
				options.report(error);
				options.say?.(
					"runs every conversation itself, since no child could be set up",
				);
			}
		}
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
			...(children ? { children: children.backend } : {}),
			...(options.say ? { say: options.say } : {}),
			...(options.changes ? { changes: options.changes } : {}),
			...slowAfter,
		});
		succeeded = backend.became;
		const control = await listenControl({
			path,
			backend,
			viewer: options.viewer?.(host),
			...(options.watch ? { watch: options.watch } : {}),
			...(children ? { children: children.routes } : {}),
			report: options.report,
			...(options.say ? { say: options.say } : {}),
			...slowAfter,
		});
		listener = control;
		wakes = backend.wake;
		listening(backend.wake);
		// Before the resumes, so one a child an earlier host left running
		// still runs is taken up there rather than started again here. One
		// that can't read which children run fails the start, since resuming
		// regardless could run a conversation in two processes at once.
		if (children) {
			const taken = await children.adopt();
			options.say?.(
				`took up ${taken} ${taken === 1 ? "child" : "children"} an earlier host left running`,
			);
		}
		const { unresumed, dropped } = await resumeHeld({
			roster,
			engine,
			admitAnother,
			starting: options.starting,
			mark: options.mark,
			finished: options.finished,
			order,
			...(options.woken ? { woken: options.woken } : {}),
			...(children ? { children: children.backend } : {}),
		});
		for (const { reason } of unresumed) options.report(reason);
		const running = host;
		let stopping: Promise<void> | undefined;
		let restarting = false;
		return {
			identity,
			path,
			unresumed,
			dropped,
			stillUnresumed: () => {
				const live = new Map(running.list().map((c) => [c.id, c.state]));
				const held = new Set(roster.entries().map((e) => e.sessionId));
				return unresumed.filter(({ sessionId }) => {
					if (children?.routes.routeOf(sessionId)) return false;
					const state = live.get(sessionId);
					return held.has(sessionId) && (state ?? "parked") === "parked";
				}).length;
			},
			inChildren: () => children?.routes.listed().length ?? 0,
			resting: () => {
				const live = new Set(running.list().map(({ id }) => id));
				const failed = new Set(unresumed.map(({ sessionId }) => sessionId));
				return roster
					.entries()
					.filter(
						({ sessionId }) =>
							!live.has(sessionId) &&
							!failed.has(sessionId) &&
							!children?.routes.routeOf(sessionId),
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
					// Each child runs on through the stop, for the next host to adopt,
					// and one still starting is let go at once rather than waited on.
					children?.close();
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
		children?.close();
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
