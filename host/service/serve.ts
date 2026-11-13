/**
 * One realm-kind host's life: take its roster's lock, own its conversations,
 * load the engine, resume what it holds, then listen. Each step refuses
 * before the next starts, so a second host, an unreadable roster or an
 * unpatched pi never gets as far as a socket. Stopping parks every
 * conversation as signalled and keeps every hold for the next start.
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
import { SessionHost } from "../engine/index.ts";
import { type HostKind, hostKey, hostSocketPath } from "./address.ts";
import {
	type ConversationEngine,
	conversationEvents,
	type HostBackend,
	hostBackend,
	type Resuming,
	resumeHeld,
	type Unresumed,
} from "./backend.ts";
import type { ControlBackend } from "./dispatch.ts";
import type { SessionIdentity } from "./protocol.ts";
import { type AdmitAnother, hostRolloutGate } from "./rollout.ts";
import { openRoster } from "./roster.ts";
import { listenControl, type ViewerBridge } from "./server.ts";

/**
 * A step a starting host has reached: building its engine, then each held
 * conversation it resumes. A host listens only after the last, so these
 * are how whoever waits on it knows a slow start still moves.
 */
export type StartStep = { readonly step: "engine" } | Resuming;

/** A running host, until stop. */
export interface ServingHost {
	readonly identity: ControlBackend["identity"];
	readonly path: string;
	/** Holds the engine could not resume at start, still held. */
	readonly unresumed: readonly Unresumed[];
	/**
	 * How many of those are still held and not running now: one woken,
	 * adopted, closed or released since no longer counts.
	 */
	stillUnresumed(): number;
	/** Each conversation the host runs, with its state and when it last changed. */
	held(): readonly Pick<SessionIdentity, "state" | "since">[];
	/**
	 * Say whether a restart of the host is coming. While it is, stopping
	 * tells every attached viewer the host is restarting before it closes
	 * the socket, so a viewer hears it only once systemd has the restart
	 * and just before the close it would otherwise take for the end.
	 */
	restartComing(coming: boolean): void;
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
	runtimeDir?: string;
	rosterDir?: string;
	registryDir?: string;
	owner?: TickedOwner;
	standing?: (owner: TickedOwner) => Promise<Standing>;
	/** Where dropped stale-context rejections are written. */
	rejectionLog?: string;
	/**
	 * What a second conversation must pass, at open, adopt and resume: by
	 * default the rollout gate over the install this host runs from.
	 */
	rollout?: AdmitAnother;
	/** Hears each step of the start before it begins. */
	starting?: (step: StartStep) => Promise<void>;
}): Promise<ServingHost> {
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
	});
	let host: SessionHost | undefined;
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
					wakes
						? wakes(sessionId)
						: listened.then((wake) => wake(sessionId)),
			}),
		);
		const { unresumed } = await resumeHeld({
			roster,
			engine,
			admitAnother,
			starting: options.starting,
		});
		for (const { reason } of unresumed) options.report(reason);
		const identity = { key: host.key, owner: host.owner };
		const backend = hostBackend({
			identity,
			host,
			roster,
			engine,
			admitAnother,
			...(options.say ? { say: options.say } : {}),
		});
		const listener = await listenControl({
			path,
			backend,
			viewer: options.viewer?.(host),
			report: options.report,
		});
		const running = host;
		let stopping: Promise<void> | undefined;
		let restarting = false;
		wakes = backend.wake;
		listening(backend.wake);
		return {
			identity,
			path,
			unresumed,
			stillUnresumed: () => {
				const live = new Set(running.list().map(({ id }) => id));
				const held = new Set(roster.entries().map((e) => e.sessionId));
				return unresumed.filter(
					({ sessionId }) => held.has(sessionId) && !live.has(sessionId),
				).length;
			},
			held: () => running.list(),
			restartComing: (coming) => {
				restarting = coming;
			},
			stop() {
				stopping ??= (async () => {
					wakes = () =>
						Promise.reject(
							new Error(
								"the host is stopping, and takes the conversation up again as it starts",
							),
						);
					if (restarting) await listener.restarting();
					await listener.close();
					// A wake already resuming finishes first, so it is parked with
					// the rest rather than left running in a host disposed under it.
					await backend.settled();
					await park(running);
					running.dispose();
					await roster.close();
				})();
				return stopping;
			},
		};
	} catch (error) {
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

async function park(host: SessionHost): Promise<void> {
	const results = await Promise.allSettled(
		host.list().map(({ id }) => host.stop(id)),
	);
	const failed = results.find((result) => result.status === "rejected");
	if (failed?.status === "rejected") throw failed.reason;
}
