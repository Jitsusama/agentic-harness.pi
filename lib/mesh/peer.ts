/**
 * This session's own peer on the mesh: who it is, which groups it is
 * in, and the presence it publishes.
 *
 * A peer's addresses follow the quest it has loaded, so they are looked
 * up again whenever they might have changed, and each time its presence
 * is published afresh. It is in two kinds of group: those its work puts
 * it in (its scopes, see scope.ts), which are worked out again with its
 * work, and those it joined, which are its own to change and survive a
 * reload, because they are kept with its presence.
 *
 * Presence is published when something in it changes (its addresses,
 * its work, its groups, whether it is mid-run, what it waits on its
 * person for, what it landed), never on a clock, so a peer at rest
 * writes nothing however long it rests. Its file is written again only
 * when a refresh finds it names another process or host, which another
 * process must have written. What it landed is kept, like
 * its joined groups, across a reload and a rollover.
 *
 * What it waits on is never kept across a start, since whatever asked
 * belonged to the process that ended.
 *
 * Long because `localPeer` is one closure over the peer's state: its
 * addresses, groups, roles and the presence last published are refreshed
 * together, each read from the others, and split apart every part would
 * pass that state around. Pure readers it uses stand outside it, above.
 */

import type { TickedOwner } from "../internal/process-ticks.ts";
import type { Orchestration } from "../internal/quest/fields/orchestration.ts";
import type { Served } from "../internal/quest/fields/serves.ts";
import { type Doing, readDoing } from "../internal/quest/sessions/doing.ts";
import { recentEvents, type SessionEvent } from "../internal/session/events.ts";
import {
	type Landing,
	standing,
	withLanding,
	withoutLanding,
} from "../internal/session/landings.ts";
import type { TerminalSessionHandle } from "../terminal/index.ts";
import {
	addressesOf,
	loadedAddress,
	olderAddresses,
	type QuestRecords,
	questAddress,
	sessionAddress,
	signaturesOfOthers,
	yieldsTo,
} from "./address.ts";
import type { Receiver } from "./attention.ts";
import type { LandingKeeper } from "./landing-history.ts";
import type { Listener } from "./message.ts";
import type { MoveOff, Moving } from "./moving.ts";
import {
	type FenceKind,
	type PeerState,
	type Presence,
	type PresenceLeases,
	type Presences,
	type QuestInfo,
	type StandsAtTop,
	workOf,
} from "./presence.ts";
import type { Share } from "./presence-shares.ts";
import { heldTreesOf } from "./scope.ts";
import { type StepDetail, stepName } from "./step.ts";
import type { Stop } from "./stop.ts";
import { ownedPrefixes, subjectsOf } from "./subjects.ts";
import { carriedUsage, type SessionUsage } from "./usage.ts";
import {
	longestStanding,
	type Want,
	type WantKind,
	wantsThePerson,
} from "./want.ts";

export interface Peer {
	readonly session: string;
	/** Stop trailing publication when this runtime shuts down. */
	dispose(): void;
	/** The addresses it answers to, the one it signs with first. */
	readonly addresses: readonly string[];
	/** The address it signs with. */
	readonly signature: string;
	/** Every group it is in, its scopes and those it joined, sorted. */
	readonly groups: readonly string[];
	/** The groups its work puts it in, sorted. */
	readonly scopes: readonly string[];
	/** The groups it joined itself, sorted. */
	readonly joined: readonly string[];
	/** The peers it has stopped reaching it (see stop.ts). */
	readonly stops: readonly Stop[];
	/** Who messages reach, as `reaches` asks. */
	readonly listener: Listener;
	/** What it works on and owns, as attention asks. */
	readonly receiver: Receiver;
	/** Whether it is in the middle of a run. */
	readonly busy: boolean;
	/** Whether its person paused it, until they resume it or talk to it. */
	readonly paused: boolean;
	/** The move its person asked, while it waits for the session to be free. */
	readonly moving: Moving | undefined;
	/** Whether a person has written in its session (driven.ts). */
	readonly driven: boolean;
	/**
	 * The address of the orchestrator its quest answers to, when one is
	 * above it.
	 */
	readonly orchestratedBy: string | undefined;
	/**
	 * The address of the orchestration it heads, when its quest
	 * orchestrates and this is the session playing the role.
	 */
	readonly orchestrates: string | undefined;
	/**
	 * The address of the person's steward above its quest, while a live
	 * session other than this one answers to it: who carries what needs
	 * the person, never work questions. A steward with nobody there
	 * carries nothing, so the person's path falls back as if none were set.
	 */
	readonly stewardedBy?: string;
	/**
	 * The address of its own quest, when that quest is the person's
	 * steward: this session ends the person's path, talking with the
	 * person rather than through its orchestrator or another steward.
	 */
	readonly stewards?: string;
	/**
	 * The address of the orchestration its quest heads, whether this
	 * session plays the role or another on the quest does; a hub from use
	 * above it would be a second voice over that work.
	 */
	readonly questHeads?: string;
	/**
	 * The quest it has loaded, as its session's record names it, when it
	 * has one; its presence says the same once published.
	 */
	readonly quest?: string;
	/** What it waits on its person for, standing longest (see want.ts). */
	readonly wants: Want | undefined;
	/**
	 * The live peer it left its quest's address to, since that peer
	 * already signed with it (see address.ts).
	 */
	readonly yieldedTo: Presence | undefined;
	/** What it landed within the day, newest first. */
	readonly landings: readonly Landing[];
	/** What it did within the hour, newest first (internal/session/events.ts). */
	readonly events: readonly SessionEvent[];
	/** Say it did this, keeping the newest twenty of the hour. */
	did(event: SessionEvent): void;
	/** Say it landed this, in place of any earlier landing of its ref. */
	landed(landing: Landing): void;
	/** Take back what landed as `ref`, when it did. */
	unlanded(ref: string): void;
	/** Say it waits on its person for this, in place of any of its kind. */
	want(want: Want): void;
	/** Say it no longer waits for this kind; answers whether it did. */
	settle(kind: WantKind): boolean;
	/**
	 * Look its addresses and work up again, and publish any change; from
	 * `everyone`, when a clock has just listed every peer off the thread,
	 * and otherwise from a listing of its own.
	 */
	refresh(everyone?: readonly Presence[]): void;
	/** Say whether it is in the middle of a run. */
	setBusy(busy: boolean): void;
	/** Say whether its person paused it. */
	setPaused(paused: boolean): void;
	/**
	 * Say the move it waits to make and what holds it, or that none waits;
	 * a move asked passes over why the last was called off.
	 */
	setMoving(moving: Moving | undefined): void;
	/** Say the move waiting is off rather than made, and why. */
	callOffMove(off: MoveOff): void;
	/** Say a person has written in its session; it stays said. */
	setDriven(): void;
	/**
	 * Say it is parking: ending idle to hold no memory until it is woken
	 * (parked.ts). It says so to the end, and its next start, a new peer,
	 * does not carry it. `wake` is the file its holder wakes it on, said
	 * in its presence so a node steering it can wake it with no live
	 * session on the machine.
	 */
	park(wake?: string): void;
	/** Say a park that failed part-way is taken back: it is up after all. */
	unpark(): void;
	/**
	 * Say its session has ended for good, as its last word, so the
	 * presence it leaves reads apart from a crashed session's. A parked
	 * peer says nothing more: it is still there to wake.
	 */
	end(): void;
	/**
	 * Say the step a run is on: the tool it is running, and what the call
	 * is about (see step.ts). Said at most once every STEP_MS, since the
	 * desktop watches presence and a run starts a tool every few seconds;
	 * the newest step said inside that window is said when it ends.
	 */
	setStep(tool: string, detail?: string): void;
	/** Say the run is thinking between tools, under the same clock. */
	setThinking(): void;
	/** What its model calls took, carried in from its last presence today. */
	readonly usage: SessionUsage | undefined;
	/** Keep this usage, said with the next presence written (usage.ts). */
	setUsage(usage: SessionUsage): void;
	/** Join a canonical group; answers whether it was new. */
	join(group: string): boolean;
	/**
	 * Leave a canonical group it joined; answers whether it had. A scope
	 * is not left this way: it follows the work.
	 */
	leave(group: string): boolean;
	/** Stop a peer reaching this one; answers whether it was new. */
	stop(stop: Stop): boolean;
	/** Lift the stop on an address; answers whether there was one. */
	lift(address: string): Stop | undefined;
}

/** Where a peer finds what it needs to know about itself. */
export interface Surroundings {
	readonly session: string;
	readonly cwd: string;
	readonly records: QuestRecords;
	readonly presences: Presences;
	/** The process holding this session, when the machine would say. */
	readonly owner?: TickedOwner;
	readonly hosted?: Presence["hosted"];
	/**
	 * The session this one carries on from, when pi rolled its log over
	 * into a fresh one: the same peer under a new session id.
	 */
	readonly previous?: string;
	/**
	 * The sessions last counted still there (see liveness.ts), or nothing
	 * before any count, when every presence is taken as there.
	 */
	readonly live?: () => ReadonlySet<string> | undefined;
	/**
	 * The window title pi gives this session now, read at each publish so
	 * a rename reaches presence with the next thing the peer says.
	 */
	readonly title?: () => string | undefined;
	/** The terminal window this session runs in, when a driver names one. */
	readonly terminal?: TerminalSessionHandle;
	/** The clock, in milliseconds; the system's unless a test sets one. */
	readonly now?: () => number;
	/**
	 * Where what it lands is kept past its presence, told whose each one
	 * is (see landing-history.ts).
	 */
	readonly history?: LandingKeeper;
	/** How its commands are fenced, when the harness says. */
	readonly fence?: FenceKind;
	/** What its harness leases, when it says (see Presence's `leases`). */
	readonly leases?: PresenceLeases;
	/**
	 * The owner lines in Joel's config, `prefix=ADDRESS` each, read at
	 * each refresh so a switch that rewrites them is said with the next
	 * (see subjects.ts). Left out, it owns no subjects by them.
	 */
	readonly owners?: () => readonly string[];
	/**
	 * The areas a quest's landings led, read at each refresh for the
	 * quest it has loaded and said after its README's subjects (see
	 * led-areas.ts). Left out, it says none.
	 */
	readonly ledAreas?: (quest: string) => readonly string[];
}

/** How long a step said stands before a newer one is said. */
export const STEP_MS = 30_000;

/**
 * What a peer is doing, as the desktop shows it: paused by its person
 * (over all else, since nothing runs until they resume it), busy
 * (mid-run, since when and on what step), waiting on its person while
 * idle, or listening.
 */
export function stateOf(
	busy: boolean,
	waiting: boolean,
	paused = false,
	parked = false,
): PeerState {
	if (parked) return "parked";
	if (paused) return "paused";
	if (busy) return "busy";
	return waiting ? "waiting" : "listening";
}

/** A step as a run says it, and when it began. */
interface Step {
	readonly kind: "tool" | "thinking";
	readonly name: string;
	readonly detail: string;
	readonly began: number;
}

/** Whether two steps are the same, whenever each began. */
function sameStep(one: Step, other: Step): boolean {
	return (
		one.kind === other.kind &&
		one.name === other.name &&
		one.detail === other.detail
	);
}

/**
 * The step presence says in full: waiting, while the person's want
 * stands mid-run, since a gate is holding the run; else the step said.
 */
function stepDetailOf(
	busy: boolean,
	step: Step | undefined,
	want: Want | undefined,
): { stepDetail?: StepDetail } {
	if (!busy) return {};
	if (want) {
		return {
			stepDetail: {
				kind: "waiting",
				name: want.kind,
				detail: want.said,
				since: want.since,
			},
		};
	}
	if (!step) return {};
	return {
		stepDetail: {
			kind: step.kind,
			name: step.name,
			detail: step.detail,
			since: new Date(step.began).toISOString(),
		},
	};
}

/**
 * A presence's doing field, read from what the quest workflow last
 * said for this session, when it said anything.
 */
function doingOf(
	folder: string | undefined,
	session: string,
): { doing?: Doing } {
	const doing = folder ? readDoing(folder, session) : undefined;
	return doing ? { doing } : {};
}

/** A presence's title field, when there is a title to say. */
function titled(title: string | undefined): { title?: string } {
	return title ? { title } : {};
}

/**
 * What a peer says of the orchestrations it is in: the orchestrator its
 * quest answers to, and the one it heads, which only the session signing
 * with the orchestrating quest's address does. That is the session that
 * had the quest first, since a later one leaves the address to it (see
 * address.ts), so two sessions on one orchestrating quest never both
 * play the role. And the person's steward above it, apart from both.
 */
export function orchestrationRoles(
	orchestration: Orchestration,
	signature: string | undefined,
): Roles {
	const heads = orchestration.heads
		? questAddress(orchestration.heads)
		: undefined;
	return {
		...(orchestration.by
			? { orchestratedBy: questAddress(orchestration.by) }
			: {}),
		...(heads && heads === signature ? { orchestrates: heads } : {}),
		...(orchestration.steward
			? { stewardedBy: questAddress(orchestration.steward) }
			: {}),
	};
}

/**
 * The roles, with the steward kept only while a live session other than
 * this one signs with its address, as yieldsTo reads a signature. Read
 * from the quests alone, a steward whose window closed would keep every
 * quest below it off the person's launcher, and sends to it would reach
 * nobody; counting any session that answers to the address would keep
 * one that only ran the steward's quest earlier, which carries nothing.
 * The signature is each peer's own word, trusted here as yieldsTo trusts
 * it: a session of the person's that wrongly signs as the steward keeps
 * questions off his launcher until it stops.
 */
export function withLiveSteward(
	roles: Roles,
	live: readonly Presence[],
	session: string,
): Roles {
	const steward = roles.stewardedBy;
	if (steward === undefined) return roles;
	const there = live.some(
		(one) => one.session !== session && one.addresses[0] === steward,
	);
	if (there) return roles;
	const { stewardedBy: _absent, ...rest } = roles;
	return rest;
}

/** What a peer's presence says of the orchestrations it is in. */
export type Roles = {
	readonly orchestratedBy?: string;
	readonly orchestrates?: string;
	readonly stewardedBy?: string;
};

/**
 * Whether a presence names the process and host this peer runs in: the
 * same owner pid, and the same host and conversation or none.
 */
function heldAsSaid(
	presence: Presence,
	at: Pick<Surroundings, "owner" | "hosted">,
): boolean {
	return (
		presence.owner?.pid === at.owner?.pid &&
		presence.hosted?.host === at.hosted?.host &&
		presence.hosted?.conversation === at.hosted?.conversation
	);
}

/** This session's peer, with the groups it last joined. */
export function localPeer(at: Surroundings): Peer {
	// A peer carried on from an earlier session is the same peer: it takes
	// that session's presence as its own, and the presence is forgotten,
	// so nobody signs with its addresses and this peer keeps them.
	const carried =
		at.previous !== undefined && at.previous !== at.session
			? at.presences.of(at.previous)
			: undefined;
	if (carried) at.presences.forget(carried.session);
	const before = at.presences.of(at.session) ?? carried;
	let joined = [...(before?.joined ?? before?.groups ?? [])].sort();
	let stops: Stop[] = [...(before?.stops ?? [])];
	const now = at.now ?? Date.now;
	let landings: Landing[] = standing(before?.landings ?? [], now());
	let events: SessionEvent[] = recentEvents(before?.events ?? [], now());
	// The trees it holds, read again at each publish (scope.ts).
	const held = heldTreesOf(at.session, at.records.trees);
	// A pause outlasts a reload, as its person left it.
	let paused = before?.state === "paused";
	// A move outlasts a reload, in the same process; the conversation that
	// takes the moved file up runs in another, and must not move again.
	let moving =
		before?.moving !== undefined &&
		before.owner !== undefined &&
		before.owner.pid === at.owner?.pid
			? before.moving
			: undefined;
	// Why its last move was called off, kept as its move would be.
	let moveOff =
		before?.moveOff !== undefined &&
		before.owner !== undefined &&
		before.owner.pid === at.owner?.pid
			? before.moveOff
			: undefined;
	// Words a person wrote stay in its log, whichever process holds it,
	// but never pass to another session, as a carried presence would.
	let driven = at.presences.of(at.session)?.driven === true;
	let parked = false;
	// When its session ended for good, once it has.
	let ended: string | undefined;
	// The file its holder wakes it on, while it's parked.
	let wakeFile: string | undefined;
	let scopes: string[] = [];
	let addresses: string[] = [];
	// Found once a start: reading every README on each refresh would
	// cost a few hundred file reads per message.
	const older = [
		...new Set([
			...olderAddresses(at.session, at.records),
			...(carried?.addresses ?? []),
		]),
	];
	let receiver: Receiver = { addresses, worksOn: "", owns: [] };
	let roles: Roles = {};
	// Kept beside the roles rather than in them, since the roles are said
	// in the presence and this is for the peer's own sends.
	let questHeads: string | undefined;
	// Kept beside the roles too: whether its own quest is the person's
	// steward, which ends the person's path here.
	let stewards: string | undefined;
	let quest: string | undefined;
	let questInfo: QuestInfo | undefined;
	let standsAtTop: StandsAtTop | undefined;
	let subjects: readonly string[] = [];
	let serves: readonly Served[] = [];
	let shares: readonly Share[] = [];
	let repo: string | undefined;
	let workspace: string | undefined;
	let busy = false;
	// When the run in progress began, and the step it was last said on.
	let since: string | undefined;
	let step: (Step & { at: number }) | undefined;
	// The newest step said inside the window, said when the window ends,
	// so a long tool started just after a short one is not hidden by it.
	let pending: Step | undefined;
	let trailing: ReturnType<typeof setTimeout> | undefined;
	const dropPending = () => {
		if (trailing) clearTimeout(trailing);
		trailing = undefined;
		pending = undefined;
	};
	const sayStep = (next: Step) => {
		step = { ...next, at: now() };
		publish();
	};
	const offerStep = (next: Step) => {
		if (!busy) return;
		if (step && sameStep(step, next)) {
			pending = undefined;
			return;
		}
		const wait = step ? STEP_MS - (now() - step.at) : 0;
		if (wait <= 0) {
			dropPending();
			sayStep(next);
			return;
		}
		pending = next;
		if (trailing) return;
		trailing = setTimeout(() => {
			const later = pending;
			trailing = undefined;
			pending = undefined;
			if (busy && later && !(step && sameStep(step, later))) sayStep(later);
		}, wait);
		trailing.unref?.();
	};
	// Every want standing, the person's or not; presence says which.
	const wanting = new Map<WantKind, Want>();
	const forPerson = (want: Want) =>
		wantsThePerson(
			want.kind,
			stewards === undefined
				? (roles.stewardedBy ?? roles.orchestratedBy)
				: undefined,
		);
	const personal = () => [...wanting.values()].filter(forPerson);
	let usage = carriedUsage(before?.usage, new Date(now()));
	const groups = () => [...new Set([...scopes, ...joined])].sort();
	// What was last published, less its time, so an unchanged presence is
	// not written again.
	let published: string | undefined;
	let disposed = false;
	const publish = () => {
		if (disposed) return;
		const said: Omit<Presence, "at"> = {
			session: at.session,
			addresses,
			groups: groups(),
			joined,
			...(stops.length > 0 ? { stops } : {}),
			worksOn: receiver.worksOn,
			owns: receiver.owns,
			...(quest ? { quest } : {}),
			busy,
			state: stateOf(busy, personal().length > 0, paused, parked),
			...(parked && wakeFile ? { wake: wakeFile } : {}),
			...(ended ? { ended } : {}),
			...(busy && since ? { since } : {}),
			...(busy && step ? { step: stepName(step) } : {}),
			...stepDetailOf(busy, step, longestStanding(personal())),
			...(personal().length > 0 ? { wants: longestStanding(personal()) } : {}),
			...(wanting.size > 0
				? {
						wanting: [...wanting.values()]
							.sort(
								(one, other) => Date.parse(one.since) - Date.parse(other.since),
							)
							.map((want) => ({ ...want, forPerson: forPerson(want) })),
					}
				: {}),
			...(usage ? { usage } : {}),
			...(landings.length > 0 ? { landings } : {}),
			...(events.length > 0 ? { events } : {}),
			...held(),
			...(at.owner ? { owner: at.owner } : {}),
			...(at.hosted ? { hosted: at.hosted } : {}),
			...titled(at.title?.()),
			...(at.terminal ? { terminal: at.terminal } : {}),
			...roles,
			...(workspace ? { workspace } : {}),
			...(questInfo ? { questInfo } : {}),
			...doingOf(at.records.doing, at.session),
			...(standsAtTop ? { standsAtTop } : {}),
			...(subjects.length > 0 ? { subjects } : {}),
			// An ended session works with nobody, so its last word serves and
			// shares none.
			...(serves.length > 0 && !ended ? { serves } : {}),
			...(shares.length > 0 && !ended ? { shares } : {}),
			cwd: at.cwd,
			...(repo ? { repo } : {}),
			...(moving ? { moving } : {}),
			...(moveOff ? { moveOff } : {}),
			driven,
			...(at.fence ? { fence: at.fence } : {}),
			...(at.leases ? { leases: at.leases } : {}),
		};
		const text = JSON.stringify(said);
		if (text === published) return;
		try {
			at.presences.publish({ ...said, at: new Date().toISOString() });
			published = text;
		} catch {
			// Unpublished, this peer still hears its groups until it ends;
			// it is only other senders who cannot see it there.
		}
	};
	let yieldedTo: Presence | undefined;
	const refresh = (listed?: readonly Presence[]) => {
		const everyone = listed ?? at.presences.all();
		// Another process wrote this peer's file: on 10 November a plain pi
		// opened a hosted conversation's log and left its own pid there,
		// which the host's peer, publishing only changes, never wrote over.
		// Two writers still alive would take turns at it each refresh; the
		// one-writer workflow ends a plain pi on a hosted log, so that's rare.
		const onDisk = everyone.find((one) => one.session === at.session);
		if (onDisk && !heldAsSaid(onDisk, at)) published = undefined;
		const counted = at.live?.();
		const live = counted
			? everyone.filter((one) => counted.has(one.session))
			: everyone;
		const signing = loadedAddress(at.session, at.records);
		yieldedTo = yieldsTo(
			at.session,
			signing,
			signing !== undefined && addresses[0] === signing,
			live,
		);
		addresses = addressesOf(
			at.session,
			at.records,
			older,
			signaturesOfOthers(at.session, everyone),
			yieldedTo !== undefined,
		);
		const work = workOf(at.session, joined, at.cwd, at.records);
		scopes = [...work.scopes];
		receiver = {
			addresses,
			worksOn: work.worksOn,
			owns: work.owns,
			...(work.hears ? { hears: work.hears } : {}),
		};
		roles = withLiveSteward(
			orchestrationRoles(work.orchestration, addresses[0]),
			live,
			at.session,
		);
		questHeads = work.orchestration.heads
			? questAddress(work.orchestration.heads)
			: undefined;
		stewards = work.orchestration.stewards
			? questAddress(work.orchestration.stewards)
			: undefined;
		quest = work.quest;
		workspace = work.workspace;
		questInfo = work.questInfo;
		standsAtTop = work.standsAtTop;
		// Owned by the work it does now: the quest it signs for, unless it
		// yielded that to another live peer, and its session's own address,
		// never an older quest's it still answers to, or a need about that
		// quest's prefix would find every session that once ran it.
		const working = [
			...(signing && yieldedTo === undefined ? [signing] : []),
			sessionAddress(at.session),
		];
		subjects = subjectsOf(ownedPrefixes(at.owners?.() ?? [], working), [
			...(work.subjects ?? []),
			...(quest && at.ledAreas ? at.ledAreas(quest) : []),
		]);
		serves = work.serves ?? [];
		shares = work.shares ?? [];
		repo = work.repo;
		publish();
	};
	refresh();
	return {
		session: at.session,
		get addresses() {
			return addresses;
		},
		get signature() {
			return addresses[0] ?? at.session;
		},
		get groups() {
			return groups();
		},
		get scopes() {
			return scopes;
		},
		get joined() {
			return joined;
		},
		get stops() {
			return stops;
		},
		dispose() {
			disposed = true;
			dropPending();
		},
		get listener() {
			return {
				addresses,
				groups: groups(),
				...(at.hosted ? { hosted: true } : {}),
			};
		},
		get receiver() {
			return receiver;
		},
		get busy() {
			return busy;
		},
		get paused() {
			return paused;
		},
		get moving() {
			return moving;
		},
		get driven() {
			return driven;
		},
		get orchestratedBy() {
			return roles.orchestratedBy;
		},
		get orchestrates() {
			return roles.orchestrates;
		},
		get stewardedBy() {
			return roles.stewardedBy;
		},
		get questHeads() {
			return questHeads;
		},
		get stewards() {
			return stewards;
		},
		get quest() {
			return quest;
		},
		get wants() {
			return longestStanding(personal());
		},
		get usage() {
			return usage;
		},
		setUsage(next) {
			usage = next;
		},
		get yieldedTo() {
			return yieldedTo;
		},
		get landings() {
			return landings;
		},
		get events() {
			return events;
		},
		did(event) {
			events = recentEvents([event, ...events], now());
			publish();
		},
		landed(landing) {
			landings = withLanding(landings, landing, now());
			publish();
			at.history?.landed(landing, {
				session: at.session,
				address: addresses[0] ?? at.session,
				...(quest ? { quest } : {}),
				...(repo ? { repo } : {}),
			});
		},
		unlanded(ref) {
			landings = withoutLanding(landings, ref);
			publish();
			at.history?.unlanded(at.session, ref);
		},
		want(want) {
			wanting.set(want.kind, want);
			publish();
		},
		settle(kind) {
			if (!wanting.delete(kind)) return false;
			publish();
			return true;
		},
		refresh,
		setBusy(running) {
			if (running && !busy) since = new Date(now()).toISOString();
			if (!running) since = undefined;
			step = undefined;
			dropPending();
			busy = running;
			publish();
		},
		setPaused(now) {
			if (paused === now) return;
			paused = now;
			publish();
		},
		setMoving(now) {
			moving = now;
			if (now !== undefined) moveOff = undefined;
			publish();
		},
		callOffMove(off) {
			moving = undefined;
			moveOff = off;
			publish();
		},
		setDriven() {
			if (driven) return;
			driven = true;
			publish();
		},
		park(wake) {
			parked = true;
			wakeFile = wake;
			publish();
			// A sender finds it parked by this, so it lands before the park.
			at.presences.settle();
		},
		unpark() {
			if (!parked) return;
			parked = false;
			wakeFile = undefined;
			publish();
		},
		end() {
			// A parked session is still there to wake, so it hasn't ended.
			if (parked) return;
			ended = new Date(now()).toISOString();
			publish();
		},
		setStep(tool, detail = "") {
			offerStep({ kind: "tool", name: tool, detail, began: now() });
		},
		setThinking() {
			offerStep({ kind: "thinking", name: "", detail: "", began: now() });
		},
		join(group) {
			if (joined.includes(group)) return false;
			joined = [...joined, group].sort();
			refresh();
			return true;
		},
		leave(group) {
			if (!joined.includes(group)) return false;
			joined = joined.filter((one) => one !== group);
			refresh();
			return true;
		},
		stop(stop) {
			if (stops.some((one) => one.address === stop.address)) return false;
			stops = [...stops, stop];
			publish();
			return true;
		},
		lift(address) {
			const lifted = stops.find((one) => one.address === address);
			if (!lifted) return undefined;
			stops = stops.filter((one) => one !== lifted);
			publish();
			return lifted;
		},
	};
}
