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
	hostBackend,
	resumeHeld,
	type Unresumed,
} from "./backend.ts";
import type { ControlBackend } from "./dispatch.ts";
import { type AdmitAnother, hostRolloutGate } from "./rollout.ts";
import { openRoster } from "./roster.ts";
import { listenControl, type ViewerBridge } from "./server.ts";

/** A running host, until stop. */
export interface ServingHost {
	readonly identity: ControlBackend["identity"];
	readonly path: string;
	/** Holds the engine could not resume at start, still held. */
	readonly unresumed: readonly Unresumed[];
	/** Close the socket, park every conversation and release the lock. */
	stop(): Promise<void>;
}

/** Start a realm-kind host, refusing at the first step that can't be trusted. */
export async function serveHost(options: {
	realm: string;
	kind: HostKind;
	engine: (host: SessionHost) => Promise<ConversationEngine>;
	report: (error: unknown) => void;
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
		const engine = await options.engine(host);
		const { unresumed } = await resumeHeld({ roster, engine, admitAnother });
		for (const { reason } of unresumed) options.report(reason);
		const identity = { key: host.key, owner: host.owner };
		const listener = await listenControl({
			path,
			backend: hostBackend({ identity, host, roster, engine, admitAnother }),
			viewer: options.viewer?.(host),
			report: options.report,
		});
		const running = host;
		let stopping: Promise<void> | undefined;
		return {
			identity,
			path,
			unresumed,
			stop() {
				stopping ??= (async () => {
					await listener.close();
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
