/**
 * A child host: one conversation in a process of its own, which its
 * realm-kind host's supervisor starts as an instance of the template
 * unit `pi-conversation-KEY@.service`, so no conversation's work can
 * hold another's thread. On 19 November one conversation held the
 * host's one thread for 3 s while a list waited 3,033 ms on it (#1874),
 * and Joel said he couldn't work for it.
 *
 * The supervisor picks the slot: the conversation's id for a resume, a
 * fresh one for an open. It writes `KEY.d/SLOT.json` under
 * `$XDG_RUNTIME_DIR/pi-host`, holding the conversation's roster entry
 * for a resume (`{"session": ENTRY}`) or nothing for an open (`{}`),
 * then starts the unit with PI_HOST_CHILD_KEY naming KEY and
 * PI_HOST_CHILD_SOCKET naming `KEY.d/SLOT.sock`. The child reads the
 * slot once, keeps a roster of that one entry in `KEY.d/SLOT.d/`, which
 * nothing outside it reads, and serves the host's own protocol on its
 * socket, so a resume resumes the conversation exactly as a host's
 * start does, and an open or adopt answers its caller as a host would.
 *
 * The supervisor follows it with a watch (server.ts): answered once the
 * child holds its conversation with the child's version, its identity
 * and the conversation, then a line each time the conversation turns
 * busy or idle (with the heap, and again every HEAP_EVERY_MS), one when
 * it becomes another inside pi, and last one saying why the child ends:
 * parked, closed, released or failed. The child then exits, 0 but for a
 * failure. It never restarts itself, never tells systemd anything, and
 * keeps no shared roster: the supervisor owns those, and clears the
 * slot's files once the child has gone.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getHeapStatistics } from "node:v8";
import {
	parseRoster,
	type RosterEntry,
	rosterPath,
} from "../../lib/core/session/roster.ts";
import { writeWhole } from "../../lib/internal/write-whole.ts";
import {
	childFolder,
	type HostKind,
	hostKeyParts,
	socketFits,
} from "./address.ts";
import { hostRefusal } from "./dispatch.ts";
import type {
	ENDINGS,
	SessionIdentity,
	WatchAnswer,
	WatchLine,
} from "./protocol.ts";
import type { WatchBridge } from "./server.ts";

/** How often, in ms, a watch hears the heap again while nothing changes. */
export const HEAP_EVERY_MS = 30_000;

/**
 * How long, in ms, a child waits for the conversation it was started
 * for before it ends as failed: an open the supervisor never sent, or
 * one that failed, leaves nothing to hold.
 */
export const FIRST_WITHIN_MS = 5 * 60_000;

/** Variables systemd gives a unit that a child must never answer for. */
const SYSTEMD_ONLY = [
	"NOTIFY_SOCKET",
	"WATCHDOG_PID",
	"WATCHDOG_USEC",
	"LISTEN_FDS",
	"LISTEN_PID",
	"LISTEN_FDNAMES",
] as const;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** A slot's name: the supervisor's own word for it, a uuid or a conversation's id. */
const SLOT_NAME = /^([A-Za-z0-9-]{1,64})\.sock$/;

/** Why a child ends, as its watch's last line says. */
export type Ending = (typeof ENDINGS)[number];

/** Where a child serves and what it was started for. */
export interface ChildSlot {
	/** The realm-kind key of the host whose child this is. */
	readonly key: string;
	readonly realm: string;
	readonly kind: HostKind;
	/** The socket it listens on. */
	readonly socket: string;
	/** The slot's name. */
	readonly slot: string;
	/** Its own folder, for its one-entry roster and its registry. */
	readonly folder: string;
	/** The conversation to resume; none for an open or adopt. */
	readonly held?: RosterEntry;
}

/**
 * Take from a child's environment the variables only systemd's notify,
 * watchdog and socket hand-over use, so neither the child nor anything
 * it starts answers systemd: the supervisor is what systemd watches.
 */
export function scrubSystemd(env: NodeJS.ProcessEnv): void {
	for (const name of SYSTEMD_ONLY) delete env[name];
}

/**
 * The slot a child was started for, from PI_HOST_CHILD_KEY and
 * PI_HOST_CHILD_SOCKET and the slot file beside the socket. Refuses a
 * key no host goes by, a socket outside the key's children's folder or
 * too long for a Unix address, and a slot file it can't read or whose
 * entry isn't one a roster holds.
 */
export function childSlot(env: NodeJS.ProcessEnv): ChildSlot {
	const key = env.PI_HOST_CHILD_KEY ?? "";
	const { realm, kind } = hostKeyParts(key);
	const socket = env.PI_HOST_CHILD_SOCKET ?? "";
	const children = childFolder(key, env.XDG_RUNTIME_DIR);
	const named = SLOT_NAME.exec(basename(socket));
	const slot = named?.[1];
	if (dirname(socket) !== children || slot === undefined)
		throw new Error(
			`PI_HOST_CHILD_SOCKET must name SLOT.sock in ${children}, not ${socket || "nothing"}`,
		);
	if (!socketFits(socket))
		throw new Error(`${socket} is too long for a Unix socket`);
	const slotFile = join(children, `${slot}.json`);
	let given: unknown;
	try {
		given = JSON.parse(readFileSync(slotFile, "utf8"));
	} catch (error) {
		throw new Error(`The child's slot ${slotFile} can't be read`, {
			cause: error,
		});
	}
	const session =
		typeof given === "object" && given !== null
			? Reflect.get(given, "session")
			: undefined;
	const folder = join(children, `${slot}.d`);
	if (session === undefined) return { key, realm, kind, socket, slot, folder };
	const roster = parseRoster(
		JSON.stringify({ v: 1, key, sessions: [session] }),
		key,
	);
	const [held] = roster?.sessions ?? [];
	if (!held)
		throw new Error(`The child's slot ${slotFile} holds no roster entry`);
	return { key, realm, kind, socket, slot, folder, held };
}

/**
 * Write the child's own roster, holding the one conversation its slot
 * names or none, whatever an earlier child of the slot left there: the
 * slot file is what the supervisor holds now. Answers its folder.
 */
export function seedChildRoster(slot: ChildSlot): string {
	mkdirSync(slot.folder, { recursive: true, mode: DIRECTORY_MODE });
	writeWhole(
		rosterPath(slot.key, slot.folder),
		`${JSON.stringify({ v: 1, key: slot.key, sessions: slot.held ? [slot.held] : [] }, null, "\t")}\n`,
		{ durable: true, mode: FILE_MODE },
	);
	return slot.folder;
}

/** The folder a child publishes its registry in, which no outside reader looks at. */
export function childRegistry(slot: ChildSlot): string {
	return join(slot.folder, "registry");
}

/** What a child's life follows of its host. */
export interface ChildLifeOptions {
	/** The harness the child runs, as its watch's answer names it. */
	readonly version: string;
	/** The child's own host identity, as a list carries it. */
	readonly identity: () => WatchAnswer["host"] | undefined;
	/** Each conversation the host runs now, as its registry holds them. */
	readonly conversations: () => readonly HostedConversation[];
	/** How much heap is used, and its limit, in bytes; v8's own by default. */
	readonly heap?: () => { used: number; limit: number };
	/** Starts a repeating timer; setInterval, unref'd, by default. */
	readonly every?: (ms: number, run: () => void) => () => void;
	/** Starts a one-off timer; setTimeout, unref'd, by default. */
	readonly after?: (ms: number, run: () => void) => () => void;
	/** How long it waits for its first conversation; FIRST_WITHIN_MS by default. */
	readonly firstWithin?: number;
}

/** A conversation as the host's registry holds it. */
export interface HostedConversation {
	readonly id: string;
	readonly file: string;
	readonly cwd: string;
	readonly state: SessionIdentity["state"];
	readonly since: string;
}

/** A child's one conversation, followed from its host's changes to its ending. */
export interface ChildLife {
	/** What its watch follows. */
	readonly watch: WatchBridge;
	/** Settles with why the child ends, once it must. */
	readonly ending: Promise<Ending>;
	/** The host published a change to what it runs. */
	changed(): void;
	/** A conversation left the host, ended as its stop or close said. */
	left(ending: "signalled" | "closed", why: string): void;
	/** A conversation is becoming another inside pi, under `nextId`. */
	becoming(previousId: string, nextId: string): void;
	/**
	 * The start's resume of the slot's conversation ended so: one left
	 * parked ends the child as parked, and one that failed as failed.
	 */
	resumed(end: "resumed" | "parked" | "unresumed"): void;
	/** The child can't go on, whatever it holds. */
	fail(): void;
	/** Stop its timers. */
	dispose(): void;
}

/** Follow a child's one conversation from its host's changes. */
export function childLife(options: ChildLifeOptions): ChildLife {
	const heap =
		options.heap ??
		(() => {
			const stats = getHeapStatistics();
			return { used: stats.used_heap_size, limit: stats.heap_size_limit };
		});
	const every =
		options.every ??
		((ms: number, run: () => void) => {
			const timer = setInterval(run, ms);
			timer.unref();
			return () => clearInterval(timer);
		});
	const after =
		options.after ??
		((ms: number, run: () => void) => {
			const timer = setTimeout(run, ms);
			// A child ending for another reason never waits on it.
			timer.unref();
			return () => clearTimeout(timer);
		});
	const followers = new Set<(line: WatchLine) => void>();
	let ended: Ending | undefined;
	let endWith = (_why: Ending): void => undefined;
	const ending = new Promise<Ending>((resolve) => {
		endWith = resolve;
	});
	let answered: WatchAnswer | undefined;
	const answers: {
		resolve: (answer: WatchAnswer) => void;
		reject: (error: unknown) => void;
	}[] = [];
	let sent: { id: string; state: string } | undefined;
	let pending: { previousId: string; nextId: string } | undefined;

	function send(line: WatchLine): void {
		for (const follow of followers) follow(line);
	}

	function identityOf(held: HostedConversation): SessionIdentity {
		const { id, file, cwd, state, since } = held;
		return { sessionId: id, file, cwd, state, since };
	}

	// The conversation it runs now: the newest, as one it became is
	// registered before the one it was leaves.
	function current(): HostedConversation | undefined {
		return options.conversations().at(-1);
	}

	function stateLine(held: HostedConversation): void {
		if (held.state === "parked") return;
		sent = { id: held.id, state: held.state };
		send({
			type: "state",
			conversation: identityOf(held),
			state: held.state,
			heap: heap(),
		});
	}

	function end(why: Ending): void {
		if (ended) return;
		ended = why;
		stopFirst();
		stopHeap();
		send({ type: "ending", why });
		for (const { reject } of answers.splice(0))
			reject(hostRefusal("ending", `The child ended: ${why}`));
		endWith(why);
	}

	const stopFirst = after(options.firstWithin ?? FIRST_WITHIN_MS, () => {
		if (!answered) end("failed");
	});
	const stopHeap = every(HEAP_EVERY_MS, () => {
		const held = current();
		if (held && answered) stateLine(held);
	});

	return {
		ending,
		watch: {
			answer() {
				if (answered) return Promise.resolve(answered);
				if (ended)
					return Promise.reject(
						hostRefusal("ending", `The child ended: ${ended}`),
					);
				return new Promise((resolve, reject) => {
					answers.push({ resolve, reject });
				});
			},
			follow(follow) {
				followers.add(follow);
				return () => followers.delete(follow);
			},
		},
		changed() {
			if (ended) return;
			const held = current();
			const host = options.identity();
			if (!held || !host) return;
			if (!answered) {
				answered = {
					version: options.version,
					host,
					conversation: identityOf(held),
				};
				stopFirst();
				for (const { resolve } of answers.splice(0)) resolve(answered);
				sent = { id: held.id, state: held.state };
				return;
			}
			if (pending && held.id === pending.nextId) {
				send({
					type: "became",
					previousId: pending.previousId,
					conversation: identityOf(held),
				});
				pending = undefined;
				sent = { id: held.id, state: held.state };
				return;
			}
			if (held.id !== sent?.id || held.state !== sent.state) stateLine(held);
		},
		left(stop, why) {
			if (ended || options.conversations().length > 0) return;
			if (!answered) {
				end("failed");
				return;
			}
			if (stop === "signalled") end("parked");
			else end(why.startsWith("released") ? "released" : "closed");
		},
		becoming(previousId, nextId) {
			pending = { previousId, nextId };
		},
		resumed(how) {
			if (how === "parked" && current() === undefined) end("parked");
			else if (how === "unresumed") end("failed");
		},
		fail() {
			end("failed");
		},
		dispose() {
			stopFirst();
			stopHeap();
		},
	};
}
