/**
 * One realm-kind host's life: take its roster's lock, own its conversations,
 * load the engine, resume what it holds, then listen. Each step refuses
 * before the next starts, so a second host, an unreadable roster or an
 * unpatched pi never gets as far as a socket. Stopping parks every
 * conversation as signalled and keeps every hold for the next start.
 */

import {
	type Standing,
	type TickedOwner,
	tickedOwnerNow,
} from "../../lib/internal/process-ticks.ts";
import { SessionHost } from "../engine/index.ts";
import { type HostKind, hostKey, hostSocketPath } from "./address.ts";
import {
	type ConversationEngine,
	hostBackend,
	resumeHeld,
	type Unresumed,
} from "./backend.ts";
import type { ControlBackend } from "./dispatch.ts";
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
}): Promise<ServingHost> {
	const key = hostKey(options.realm, options.kind);
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
		const { unresumed } = await resumeHeld({ roster, engine });
		for (const { reason } of unresumed) options.report(reason);
		const identity = { key: host.key, owner: host.owner };
		const listener = await listenControl({
			path,
			backend: hostBackend({ identity, host, roster, engine }),
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
