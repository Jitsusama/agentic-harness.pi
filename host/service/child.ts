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
 * `<runtime folder>/pi-host`, holding the conversation's roster entry
 * for a resume (`{"session": ENTRY}`) or nothing for an open (`{}`),
 * then starts the unit with PI_HOST_CHILD_KEY naming KEY and
 * PI_HOST_CHILD_SOCKET naming `KEY.d/SLOT.sock`. A slot holding
 * `{"spare": true}` is a warm spare's, which warms and waits until the
 * supervisor writes it one of the two (spare.ts). The child reads the
 * slot once, refusing a file that is neither, and keeps a roster of that
 * one entry in `KEY.d/SLOT.d/`, written once it holds the roster's lock,
 * so a child of the slot still stopping never writes under it. It serves
 * the host's own protocol on its socket, so a resume resumes the
 * conversation exactly as a host's start does, and an open or adopt
 * answers its caller as a host would. It lists what it runs in the
 * machine's own host registry, under its own process, so plain pi's
 * one-writer guard sees the conversation it holds.
 *
 * The supervisor keeps one child for a conversation at a time: a slot's
 * lock keeps two children of one slot apart, but a conversation opened
 * in one slot and resumed in another is the supervisor's to keep apart.
 *
 * The supervisor follows it with a watch (server.ts): answered once the
 * child holds its conversation with the child's version, its identity,
 * the conversation and its roster entry (an open's launch is the
 * child's to derive, and the supervisor's shared roster must replay it),
 * then a line each time the conversation turns busy or idle (with the
 * heap, and again every HEAP_EVERY_MS), one with the new entry when it
 * becomes another inside pi, and last one saying why the child ends:
 * parked, closed, released or failed. A watch the child ends before
 * answering is refused, and still hears the ending after the refusal.
 * The child then exits, 0 but for a failure or a stop that ran out of
 * time before it parked, which exit 1; one whose slot or environment is
 * refused exits 78 before it listens. A stop says parked as it starts
 * parking, since its socket closes first, so its exit says whether the
 * park finished. A conversation that parks itself, or that its start
 * left resting, keeps its child while a window views it, and for
 * ALONE_WITHIN_MS once none does, so a wake finds it. It never restarts itself, never tells systemd anything, and
 * keeps no shared roster: the supervisor owns those, and clears the
 * slot's files once the child has gone.
 *
 * The conversation's durable store is the child's alone: the supervisor
 * never opens it, not even to read, since a second process holding the
 * file's locks is what a child is there to keep off its thread.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getHeapStatistics } from "node:v8";
import {
	parseRoster,
	type RosterEntry,
	rosterPath,
} from "../../lib/core/session/roster.ts";
import { runtimeDir } from "../../lib/internal/paths.ts";
import type { SessionHost } from "../engine/index.ts";
import type { HostLeaving } from "../engine/session-host.ts";
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
 * How long, in ms, a child started for an open waits for its
 * conversation before it ends as failed: an open the supervisor never
 * sent, or one that failed, leaves nothing to hold. A child that resumes
 * its slot keeps no such wait, since its resume's own end says how it
 * went, and one slow under load would otherwise end failed and then park
 * what had just come up.
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

/** What a slot file may hold. */
const SLOT_FIELDS: ReadonlySet<string> = new Set(["session", "woken"]);
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
	/** Its own folder, for its one-entry roster and its engine's notes. */
	readonly folder: string;
	/** The conversation to resume; none for an open or adopt. */
	readonly held?: RosterEntry;
	/**
	 * Whether the supervisor woke `held` from a rest it kept, so the child
	 * resumes it as woken rather than resting it again.
	 */
	readonly woken?: boolean;
}

/** The gate a child keeps: it runs one conversation, and a second is refused. */
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
	const { key, realm, kind, socket, slot, slotFile, folder } =
		childSlotPlaces(env);
	let given: unknown;
	try {
		given = JSON.parse(readFileSync(slotFile, "utf8"));
	} catch (error) {
		throw new Error(`The child's slot ${slotFile} can't be read`, {
			cause: error,
		});
	}
	if (!slotRecord(given))
		throw new Error(
			`The child's slot ${slotFile} must hold {} for an open or {"session": ENTRY} for a resume`,
		);
	const record = given;
	const session = Reflect.get(record, "session");
	if (session === undefined) return { key, realm, kind, socket, slot, folder };
	const roster = parseRoster(
		JSON.stringify({ v: 1, key, sessions: [session] }),
		key,
	);
	const [held] = roster?.sessions ?? [];
	if (!held)
		throw new Error(`The child's slot ${slotFile} holds no roster entry`);
	const woken = Reflect.get(record, "woken") === true;
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

/** Where a child's slot is, from its environment, before its file is read. */
export interface ChildSlotPlaces {
	readonly key: string;
	readonly realm: string;
	readonly kind: HostKind;
	readonly socket: string;
	readonly slot: string;
	/** SLOT.json, what the supervisor wrote for it. */
	readonly slotFile: string;
	/** SLOT.d, its own folder. */
	readonly folder: string;
}

/**
 * Where the slot named by PI_HOST_CHILD_KEY and PI_HOST_CHILD_SOCKET is,
 * refusing as childSlot does, without reading its file: a spare reads
 * that only once it is warm (spare.ts).
 */
export function childSlotPlaces(env: NodeJS.ProcessEnv): ChildSlotPlaces {
	const key = env.PI_HOST_CHILD_KEY ?? "";
	const { realm, kind } = hostKeyParts(key);
	const socket = env.PI_HOST_CHILD_SOCKET ?? "";
	const children = childFolder(key, runtimeDir(env));
	const named = SLOT_NAME.exec(basename(socket));
	const slot = named?.[1];
	if (dirname(socket) !== children || slot === undefined)
		throw new Error(
			`PI_HOST_CHILD_SOCKET must name SLOT.sock in ${children}, not ${socket || "nothing"}`,
		);
	if (!socketFits(socket))
		throw new Error(`${socket} is too long for a Unix socket`);
	return {
		key,
		realm,
		kind,
		socket,
		slot,
		slotFile: join(children, `${slot}.json`),
		folder: join(children, `${slot}.d`),
	};
}

/**
 * Whether a slot file holds what a slot does: an object with nothing but
 * `session` and `woken`, so a typo or a corrupt file is refused rather
 * than read as an open.
 */
function slotRecord(given: unknown): given is object {
	if (typeof given !== "object" || given === null || Array.isArray(given))
		return false;
	return Object.keys(given).every((name) => SLOT_FIELDS.has(name));
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
 * variables taken out before anything reads them, its slot read, and
 * the life that follows its one conversation over the host runHost
 * builds, saying `version` as the child's version.
 * Refuses as childSlot does.
 */
export function childHost(env: NodeJS.ProcessEnv, version: string): ChildHost {
	scrubSystemd(env);
	const slot = childSlot(env);
	let hosted: SessionHost | undefined;
	const life = childLife({
		version,
		identity: () =>
			hosted ? { key: hosted.key, owner: hosted.owner } : undefined,
		conversations: () => hosted?.list() ?? [],
		entry: childEntry(slot),
		resumes: slot.held !== undefined,
		stale: () => hosted?.rolls() ?? false,
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
 * What the child's own roster holds once its lock is taken: the one
 * conversation its slot names, or none, whatever an earlier child of the
 * slot left there, since the slot file is what the supervisor holds now.
 */
export function childRosterSeed(slot: ChildSlot): readonly RosterEntry[] {
	return slot.held ? [slot.held] : [];
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
			// Not written yet: no entry this time. It is replaced whole by a
			// rename, so a read never finds it half-written.
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
	/** It resumes its slot's conversation, so keeps no first wait. */
	readonly resumes?: boolean;
	/** How long it stays parked with nobody viewing; ALONE_WITHIN_MS by default. */
	readonly aloneWithin?: number;
	/**
	 * Whether its host's own code is stale, so it ends as soon as its
	 * conversation parks away unviewed, with no grace: a wake within one
	 * would resume it on the code it rolled to leave. Never, by default.
	 */
	readonly stale?: () => boolean;
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
	/**
	 * A conversation left the host, ended as its stop or close said. One
	 * stopped while the child isn't, as an idle park is, rests for a wake
	 * while a window views it and for its grace once none does. One whose
	 * start neither answered nor rested ends the child failed.
	 */
	left(ending: HostLeaving, why: string): void;
	/** A conversation is becoming another inside pi, under `nextId`. */
	becoming(previousId: string, nextId: string): void;
	/**
	 * The start's resume of the slot's conversation ended so. One that
	 * failed ends the child as failed. One left parked, as it rested
	 * before, waits for a wake as a parked one does, ending as parked once
	 * nobody has viewed it for its grace.
	 */
	resumed(end: "resumed" | "parked" | "unresumed"): void;
	/**
	 * The child is stopping: parked once its start worked, holding its
	 * conversation or resting it as the slot left it, else failed.
	 */
	stopping(): void;
	/** The conversation it runs, or last ran, by id; none before the first. */
	conversation(): string | undefined;
	/** The child can't go on, whatever it holds. */
	fail(): void;
	/** Stop every timer it keeps. */
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
	// The conversation is parked out of the host, by itself or as the
	// start left it, and waits for a wake.
	let away = false;
	// How many windows view the conversation, and what ends a grace
	// nobody viewing it, once one runs.
	let viewing = 0;
	let stopAlone: (() => void) | undefined;

	// Whether an end that stops it parks or ends it as asked rather than
	// calling the child failed: its start answered, or it still rests
	// parked as the slot left it. A wake that registered and died before
	// it answered ended the rest, so it no longer does.
	function endsAsAsked(): boolean {
		return answered !== undefined || resting;
	}

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

	// A conversation parked away that nobody views ends its child once its
	// grace passes, or at once on stale host code; a window joining, or a
	// wake, ends the grace. One the host still lists, parked only while it
	// closes, never arms it.
	function weighAlone(): void {
		if (away && viewing === 0 && options.stale?.() === true) {
			end("parked");
			return;
		}
		if (away && viewing === 0) {
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

	const stopFirst = options.resumes
		? () => undefined
		: after(options.firstWithin ?? FIRST_WITHIN_MS, () => {
				// A rest comes only from a slot it resumes, which keeps no first
				// wait, so a first wait that passes unanswered is a failure.
				if (!answered) end("failed");
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
			// A watch that comes later, as a supervisor restarted meanwhile
			// sends, is told what the conversation became, not what it was.
			answered = { ...answered, conversation: identityOf(held), entry };
			return;
		}
		if (held.id !== sent?.id || held.state !== sent.state) stateLine(held);
	}

	return {
		ending,
		watch: {
			answer() {
				if (answered) {
					// As it stands now, its state among it, for a watch that comes late.
					const held = current();
					const now =
						held && held.id === answered.conversation.sessionId
							? { ...answered, conversation: identityOf(held) }
							: answered;
					return Promise.resolve(now);
				}
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
			// A wake that registers ends the rest: one that dies before it
			// answers then ends the child failed, rather than resting parked as
			// it was. A wake answers as it registers once its roster names it.
			// One whose build fails after that stays listed parked, as any
			// failed start in a child does, until it is closed or the host
			// stops. One that throws before it registers changes nothing held,
			// so the rest stands: the conversation is still parked as the slot
			// left it, for a later wake, and the child ends parked.
			if (held) {
				away = false;
				resting = false;
			}
			followChange(held);
			weighAlone();
		},
		viewers(_sessionId, count) {
			// A child runs one conversation, so whichever id its terminal goes
			// by mid-became, the count is that conversation's.
			if (ended || count === viewing) return;
			viewing = count;
			const held = current();
			if (held && answered) stateLine(held);
			weighAlone();
		},
		left(stop) {
			if (ended || options.conversations().length > 0) return;
			// One resting parked was never answered, as it hadn't woken, and
			// leaves as it was asked to rather than failing.
			if (!endsAsAsked()) {
				end("failed");
				return;
			}
			if (stop !== "signalled") {
				end(stop);
				return;
			}
			away = true;
			weighAlone();
		},
		becoming(previousId, nextId) {
			pending = { previousId, nextId };
		},
		resumed(how) {
			if (how === "unresumed") end("failed");
			if (how !== "parked" || ended) return;
			resting = true;
			away = true;
			weighAlone();
		},
		stopping() {
			end(endsAsAsked() ? "parked" : "failed");
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
			stopAlone?.();
			stopAlone = undefined;
		},
	};
}
