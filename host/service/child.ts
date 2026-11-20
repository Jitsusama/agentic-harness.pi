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
 * child holds its conversation with the child's version, its identity,
 * the conversation and its roster entry (an open's launch is the
 * child's to derive, and the supervisor's shared roster must replay it),
 * then a line each time the conversation turns busy or idle (with the
 * heap, and again every HEAP_EVERY_MS), one with the new entry when it
 * becomes another inside pi, and last one saying why the child ends:
 * parked, closed, released or failed. The child then exits, 0 but for a
 * failure. It never restarts itself, never tells systemd anything, and
 * keeps no shared roster: the supervisor owns those, and clears the
 * slot's files once the child has gone.
 *
 * The conversation's durable store is the child's alone: the supervisor
 * never opens it, not even to read, since a second process holding the
 * file's locks is what a child is there to keep off its thread.
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
import type { SessionHost } from "../engine/index.ts";
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
import { type AdmitAnother, ROLLOUT_REFUSED } from "./rollout.ts";
import type { WatchBridge } from "./server.ts";

/** How often, in ms, a watch hears the heap again while nothing changes. */
export const HEAP_EVERY_MS = 30_000;

/**
 * How long, in ms, a child waits for the conversation it was started
 * for before it ends as failed: an open the supervisor never sent, or
 * one that failed, leaves nothing to hold.
 */
export const FIRST_WITHIN_MS = 5 * 60_000;

/**
 * How long, in ms, a parked conversation may go with no window viewing
 * it before its child ends as parked: a window that left and joins again
 * at once finds it still there, and the child holds no memory for one
 * nobody watches.
 */
export const ALONE_WITHIN_MS = 30_000;

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
	/**
	 * Whether the supervisor woke `held` from a rest it kept, so the child
	 * resumes it as woken rather than resting it again.
	 */
	readonly woken?: boolean;
}

/** The rollout gate a child keeps: it runs one conversation, and a second is refused. */
export const oneConversation: AdmitAnother = () =>
	Promise.reject(
		hostRefusal(
			ROLLOUT_REFUSED,
			"A child host runs one conversation; its supervisor starts another child for the next",
		),
	);

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
	const record =
		typeof given === "object" && given !== null ? given : undefined;
	const session = record ? Reflect.get(record, "session") : undefined;
	const folder = join(children, `${slot}.d`);
	if (session === undefined) return { key, realm, kind, socket, slot, folder };
	const roster = parseRoster(
		JSON.stringify({ v: 1, key, sessions: [session] }),
		key,
	);
	const [held] = roster?.sessions ?? [];
	if (!held)
		throw new Error(`The child's slot ${slotFile} holds no roster entry`);
	const woken = record ? Reflect.get(record, "woken") === true : false;
	return {
		key,
		realm,
		kind,
		socket,
		slot,
		folder,
		held,
		...(woken ? { woken } : {}),
	};
}

/** A child as its program runs it: its slot, its life, and what it holds. */
export interface ChildHost {
	readonly slot: ChildSlot;
	readonly life: ChildLife;
	/** Give it the host it runs, once runHost has built it. */
	hosts(host: SessionHost): void;
	/** The conversation whose kept commands it keeps: its own, or the slot's. */
	conversation(): string;
}

/**
 * A child from its environment, as its program starts one: systemd's
 * variables taken out before anything reads them, its slot read, its
 * roster seeded, and the life that follows its one conversation over
 * the host runHost builds, saying `version` as the child's version.
 * Refuses as childSlot does.
 */
export function childHost(env: NodeJS.ProcessEnv, version: string): ChildHost {
	scrubSystemd(env);
	const slot = childSlot(env);
	seedChildRoster(slot);
	let hosted: SessionHost | undefined;
	const life = childLife({
		version,
		identity: () =>
			hosted ? { key: hosted.key, owner: hosted.owner } : undefined,
		conversations: () => hosted?.list() ?? [],
		entry: childEntry(slot),
	});
	return {
		slot,
		life,
		hosts(host) {
			hosted = host;
		},
		conversation: () =>
			life.conversation() ?? slot.held?.sessionId ?? slot.slot,
	};
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

/**
 * The entry the child's own roster holds for a conversation, read from
 * its file, or none while it holds none: the host writes an open's
 * entry before it registers the conversation, and a became's before it
 * registers the new one, so a held conversation has one.
 */
export function childEntry(
	slot: ChildSlot,
): (sessionId: string) => RosterEntry | undefined {
	const path = rosterPath(slot.key, slot.folder);
	return (sessionId) => {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			// Not written yet, or mid-replacement: no entry this time.
			return undefined;
		}
		return parseRoster(text, slot.key)?.sessions.find(
			(held) => held.sessionId === sessionId,
		);
	};
}

/** What a child's life follows of its host. */
export interface ChildLifeOptions {
	/** The harness the child runs, as its watch's answer names it. */
	readonly version: string;
	/** The child's own host identity, as a list carries it. */
	readonly identity: () => WatchAnswer["host"] | undefined;
	/** Each conversation the host runs now, as its registry holds them. */
	readonly conversations: () => readonly HostedConversation[];
	/** The child's roster entry for a conversation, or none yet. */
	readonly entry: (sessionId: string) => RosterEntry | undefined;
	/** How much heap is used, and its limit, in bytes; v8's own by default. */
	readonly heap?: () => { used: number; limit: number };
	/** Starts a repeating timer; setInterval, unref'd, by default. */
	readonly every?: (ms: number, run: () => void) => () => void;
	/** Starts a one-off timer; setTimeout, unref'd, by default. */
	readonly after?: (ms: number, run: () => void) => () => void;
	/** How long it waits for its first conversation; FIRST_WITHIN_MS by default. */
	readonly firstWithin?: number;
	/** How long it stays parked with nobody viewing; ALONE_WITHIN_MS by default. */
	readonly aloneWithin?: number;
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
	/** How many windows view `sessionId`'s screen, said each time it changes. */
	viewers(sessionId: string, count: number): void;
	/** A conversation left the host, ended as its stop or close said. */
	left(ending: "signalled" | "closed", why: string): void;
	/** A conversation is becoming another inside pi, under `nextId`. */
	becoming(previousId: string, nextId: string): void;
	/**
	 * The start's resume of the slot's conversation ended so. One that
	 * failed ends the child as failed. One left parked, as it rested
	 * before, waits for the wake the supervisor sends, and ends as parked
	 * if none comes within the first wait.
	 */
	resumed(end: "resumed" | "parked" | "unresumed"): void;
	/** The child is stopping: parked once it held its conversation, else failed. */
	stopping(): void;
	/** The conversation it runs, or last ran, by id; none before the first. */
	conversation(): string | undefined;
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
	// The slot's conversation rests parked, as it did before the start.
	let resting = false;
	// How many windows view the conversation, and what ends a grace
	// nobody viewing it, once one runs.
	let viewing = 0;
	let stopAlone: (() => void) | undefined;

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
			viewers: viewing,
		});
	}

	// A parked conversation nobody views ends its child once its grace
	// passes; a window joining, or a wake, ends the grace.
	function weighAlone(held: HostedConversation | undefined): void {
		if (answered && held?.state === "parked" && viewing === 0) {
			stopAlone ??= after(options.aloneWithin ?? ALONE_WITHIN_MS, () =>
				end("parked"),
			);
			return;
		}
		stopAlone?.();
		stopAlone = undefined;
	}

	function end(why: Ending): void {
		if (ended) return;
		ended = why;
		stopFirst();
		stopHeap();
		stopAlone?.();
		send({ type: "ending", why });
		for (const { reject } of answers.splice(0))
			reject(hostRefusal("ending", `The child ended: ${why}`));
		endWith(why);
	}

	const stopFirst = after(options.firstWithin ?? FIRST_WITHIN_MS, () => {
		if (!answered) end(resting ? "parked" : "failed");
	});
	const stopHeap = every(HEAP_EVERY_MS, () => {
		const held = current();
		if (held && answered) stateLine(held);
	});

	// The first conversation answers the watch; one it became says so;
	// any other change of id or state says the state.
	function followChange(held: HostedConversation | undefined): void {
		const host = options.identity();
		if (!held || !host) return;
		if (!answered) {
			const entry = options.entry(held.id);
			if (!entry) return;
			answered = {
				version: options.version,
				host,
				conversation: identityOf(held),
				entry,
			};
			stopFirst();
			for (const { resolve } of answers.splice(0)) resolve(answered);
			sent = { id: held.id, state: held.state };
			return;
		}
		if (pending && held.id === pending.nextId) {
			const entry = options.entry(held.id);
			if (!entry) return;
			send({
				type: "became",
				previousId: pending.previousId,
				conversation: identityOf(held),
				entry,
			});
			pending = undefined;
			sent = { id: held.id, state: held.state };
			return;
		}
		if (held.id !== sent?.id || held.state !== sent.state) stateLine(held);
	}

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
				// A watch that comes once the child said its ending, as a host
				// started meanwhile sends, hears the ending again at once, so its
				// supervisor lets the slot go rather than stopping the unit.
				if (ended) {
					follow({ type: "ending", why: ended });
					return () => undefined;
				}
				followers.add(follow);
				return () => followers.delete(follow);
			},
		},
		changed() {
			if (ended) return;
			const held = current();
			followChange(held);
			weighAlone(held);
		},
		viewers(_sessionId, count) {
			// A child runs one conversation, so whichever id its terminal goes
			// by mid-became, the count is that conversation's.
			if (ended || count === viewing) return;
			viewing = count;
			const held = current();
			if (held && answered) stateLine(held);
			weighAlone(held);
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
			if (how === "parked") resting = true;
			else if (how === "unresumed") end("failed");
		},
		stopping() {
			end(answered || resting ? "parked" : "failed");
		},
		conversation() {
			return current()?.id ?? sent?.id;
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
