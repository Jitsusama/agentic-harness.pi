/** The contract a multi-session host installs before loading extensions. */
import type { TickedOwner } from "../../internal/process-ticks.ts";
import type { FenceKind } from "../../mesh/presence.ts";

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
	/** What a sprout seeded this session with, as the node wrote it, unread. */
	sprout?: string;
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
	/**
	 * Whether a move waiting for the conversation holds this reload off,
	 * as it does the install follower's own, which asks again once the
	 * move lets go. A host refuses one once the conversation is idle if a
	 * move waits then, since the reload would stop the move unwritten.
	 */
	readonly yieldsToMove?: boolean;
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
	/**
	 * Whether the host drains this conversation for a restart: it parks as
	 * soon as its park rule holds, idle time aside, so a host whose
	 * conversations take turns that overlap reaches a moment with none
	 * running. Asked at each look, so a drain lifted lets it wait its usual
	 * time again; one the person woke during the drain isn't drained again.
	 * A host that never drains leaves it out.
	 */
	draining?(sessionId: string): boolean;
	/**
	 * Whether this conversation rolls onto new host code: its host's own
	 * code is stale and no window views it, so it parks as soon as its park
	 * rule holds, idle time aside, and its next wake starts on current
	 * code. Unlike a drain, a roll holds no wake. Asked at each look. A
	 * host that never rolls leaves it out.
	 */
	rolling?(sessionId: string): boolean;
	/**
	 * Whether a window views this conversation now, so the person may be
	 * reading it and would pay its wake at their next key. Asked at each
	 * look. A host without screens leaves it out.
	 */
	viewed?(sessionId: string): boolean;
	/**
	 * Whether a park of this conversation carries its bash calls: the host
	 * keeps a carried call alive through the stop, and wakes the
	 * conversation once the last ends, so a call out need not keep it
	 * awake. Asked at each look. A host that keeps none leaves it out.
	 */
	carries?(sessionId: string): boolean;
	/**
	 * Told the fence one of this conversation's tools holds it to, `by`
	 * its shell, as its runner starts and before each command, or by the
	 * guard on pi's file tools, as its runner starts and at each call. The
	 * record names the loosest told since the conversation opened here, and
	 * only once its present runner's shell and file guard have both told
	 * one, since a runner without either runs those tools unfenced. False
	 * when the record couldn't be written, so the tool refuses what it
	 * would run. A host that keeps no record leaves it out.
	 */
	fenced?(sessionId: string, fence: FenceKind, by: FenceTeller): boolean;
	/**
	 * Told one of this conversation's guards shut down with its runner, as
	 * pi shuts a runner down before it reloads one, whoever asked, so the
	 * record names no fence until the next runner's shell and file guard
	 * tell one. A host that keeps no record leaves it out.
	 */
	left?(sessionId: string): void;
}

/** Which of a conversation's tools told its host a fence (Host.fenced). */
export type FenceTeller = "shell" | "files";

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
 * for itself, or for any stop where its engine can keep bash calls alive
 * (host/engine/carried-shells.ts): the next host resumes the
 * conversation, so what can outlive the stop may be carried to it, as a
 * move carries it. A separate event
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
	/**
	 * How the agent's tools are fenced, the loosest they told the host
	 * since the conversation opened in it, a park, a release or a
	 * replacement between, so a command an earlier runner started counts
	 * too, though not yet across a host's restart: a host's
	 * process says nothing of any one session's, so a mycelium node
	 * carrying it reads this (KP0L6A, 19 November). A command the person
	 * types with `!` runs as pi runs it, outside this. It speaks for
	 * what pi's shell and file guards hold: a runner where neither loaded
	 * tells nothing, so what it started isn't counted here, and the
	 * language servers the lsp tool starts, a project's own among them,
	 * run outside any fence. Missing until its
	 * present runner's shell and file guard both say, from an older
	 * harness's record, where a later harness's word isn't known here, and
	 * wherever the record lies past a link, outside what the fence keeps
	 * read-only or under a folder another account may write, from pi's
	 * state folder down, now or when the host started, so the node refuses.
	 */
	readonly fence?: FenceKind;
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
