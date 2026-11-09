/** The contract a multi-session host installs before loading extensions. */
import type { TickedOwner } from "../../internal/process-ticks.ts";

/** An open conversation's standing in its host. */
export type HostedState = "busy" | "idle" | "parked";

/** A session's mutable environment, not the host process's environment. */
export interface SessionEnvironment {
	get(name: string): string | undefined;
	set(name: string, value: string): void;
	delete(name: string): void;
	snapshot(): NodeJS.ProcessEnv;
}

/** Hints consumed once when a conversation starts, not on reload. */
export interface LaunchHints {
	questId?: string;
	orchestrate?: boolean;
	/** Hosted words are literal; plain pi uses firstWordsToken to read its file. */
	firstWords?: string;
	firstWordsToken?: string;
}

/** The host supplies one of these before any extension is loaded. */
export interface Host {
	readonly kind: "pi-durable";
	readonly key: string;
	readonly owner: TickedOwner;
	holds(sessionId: string): HostedState | undefined;
	env(sessionId: string): SessionEnvironment;
	/** Returns and consumes the launch hints for this session. */
	hints(sessionId: string): LaunchHints;
	close(sessionId: string, why: string): void | Promise<void>;
	stamp(sessionId: string, how: "signalled" | "closed"): void | Promise<void>;
}

/** An entry in the host's list of currently open conversations. */
export interface HostedSession {
	readonly id: string;
	readonly state: HostedState;
	/** ISO timestamp of the last state change. */
	readonly since: string;
}

/** Rewritten atomically by the host on every open, close and state change. */
export interface HostRegistry {
	readonly key: string;
	readonly owner: TickedOwner;
	readonly sessions: readonly HostedSession[];
}

const HOST_KEY = Symbol.for("agentic-harness.host.v1");

/** The host installed in this process, absent on plain pi. */
export function hosted(): Host | undefined {
	return (globalThis as { [HOST_KEY]?: Host })[HOST_KEY];
}

/** Install one host per process; the returned cleanup removes only that host. */
export function installHost(host: Host): () => void {
	const holder = globalThis as { [HOST_KEY]?: Host };
	if (holder[HOST_KEY] !== undefined)
		throw new Error("A session host is already installed");
	holder[HOST_KEY] = host;
	return () => {
		if (holder[HOST_KEY] === host) delete holder[HOST_KEY];
	};
}
