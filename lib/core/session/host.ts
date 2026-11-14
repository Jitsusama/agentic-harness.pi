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
	/**
	 * The names it holds, without copying it, where it can say them
	 * cheaply. A host's process.env lists through this on every child
	 * started with no env of its own.
	 */
	names?(): readonly string[];
}

/** Hints consumed once when a conversation starts, not on reload. */
export interface LaunchHints {
	questId?: string;
	orchestrate?: boolean;
	/** Hosted words are literal; plain pi uses firstWordsToken to read its file. */
	firstWords?: string;
	firstWordsToken?: string;
}

/** What a conversation asks of its host when its extensions should load again. */
export interface HostReloadRequest {
	/** Why, in the asker's words. */
	readonly reason: string;
	/**
	 * A tree to load in place of what runs. A host refuses one, since its
	 * extensions load into a process every conversation shares.
	 */
	readonly onto?: string;
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
	/**
	 * Reload one conversation's extensions, keeping its ownership, slots
	 * and environment, and leaving every other conversation running. A
	 * host whose runner can't reload a conversation leaves it out.
	 */
	reload?(sessionId: string, request: HostReloadRequest): Promise<void>;
	/**
	 * Park one idle conversation, as plain pi's park ends its process: its
	 * session, extensions and screen go, while the host keeps it held, its
	 * viewers connected, and wakes it in place when its wake file is
	 * written (MYCELIUM_WAKE in its environment), a viewer types or one
	 * attaches. Asked by the conversation itself once its park rule holds;
	 * the park happens after the asking call returns. A host that can't
	 * park a conversation leaves it out.
	 */
	park?(sessionId: string): void;
}

/** Host.stamp emits this on the conversation bus within withSession. */
export const SESSION_STAMP_EVENT = "agentic-harness:session-stamp";

/** A host ending, never a runner reload or a viewer detachment. */
export interface SessionStamp {
	session: string;
	how: "signalled" | "closed";
}

/** Narrow an event from the shared bus before changing a session record. */
export function isSessionStamp(value: unknown): value is SessionStamp {
	return (
		!!value &&
		typeof value === "object" &&
		"session" in value &&
		typeof value.session === "string" &&
		value.session.length > 0 &&
		"how" in value &&
		(value.how === "signalled" || value.how === "closed")
	);
}

/**
 * A host emits this on a conversation's bus, within withSession, just
 * before it stamps the conversation `signalled` for a restart it asked
 * for itself: the next host resumes the conversation, so what can outlive
 * the stop may be carried to it, as a move carries it. A separate event
 * rather than a third stamp, since a reader of stamps takes any other
 * than `signalled` for the conversation's own quit, and one that never
 * hears this stops its work as at any other stop.
 */
export const HOST_RESTARTING_EVENT = "agentic-harness:host-restarting";

/** What HOST_RESTARTING_EVENT carries. */
export interface HostRestarting {
	session: string;
}

/** Whether an event from the shared bus says a host is restarting. */
export function isHostRestarting(value: unknown): value is HostRestarting {
	return (
		!!value &&
		typeof value === "object" &&
		"session" in value &&
		typeof value.session === "string" &&
		value.session.length > 0
	);
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
