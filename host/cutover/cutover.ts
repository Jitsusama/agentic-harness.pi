/**
 * The cutover: every live pi on this machine moved into the realm's
 * host, keeping its session and so its address (OSPHT4's plan item 12).
 *
 * Nothing is ended from outside. Each session is told, through its steer
 * inbox, to move (lib/mesh/steer.ts); it ends itself the first moment it
 * is free, nothing running, waiting, asked or typed, and leaves a move
 * note saying where it goes (lib/internal/session/move.ts). Once its pi
 * has gone, the cutover asks that host to adopt its log and takes the
 * note away. A busy session follows as it goes quiet; one whose pi
 * still runs a harness without the move is named to reload first; a
 * parked one is woken to take its move. Sessions elsewhere (penelope,
 * the Mac) are left alone, as is the session running the cutover.
 *
 * A session whose window is on the workspace Joel has focused is left
 * too, since a move may close or redraw that window, as is one whose
 * window can't be placed (OSPHT4, 11 November). Both are judged as the
 * cutover plans and again just before each session is told, as Joel
 * may have moved since. One whose holder may predate mycelium #121
 * still moves, saying its window may show a Parked line for a moment
 * (windows.ts).
 */

import type { MoveNote } from "../../lib/internal/session/move.ts";
import type { MoveOff } from "../../lib/mesh/moving.ts";
import type { Presence } from "../../lib/mesh/presence.ts";
import type { HostKind } from "../service/address.ts";
import { type HostOverrides, hostFor, NO_OVERRIDES } from "./attended.ts";
import type { WindowStanding } from "./windows.ts";

/** What becomes of one session, and why. */
export type Step =
	| {
			readonly kind: "move";
			readonly session: string;
			readonly address: string;
			readonly to: HostKind;
			readonly why: string;
			readonly parked: boolean;
	  }
	| {
			readonly kind: "reload" | "leave";
			readonly session: string;
			readonly address: string;
			readonly why: string;
	  };

/** A move step. */
export type MoveStep = Extract<Step, { kind: "move" }>;

/** What the cutover asks of the machine; tests give their own. */
export interface CutoverFacts {
	/** Every live session on the mesh, hosted or not, here or elsewhere. */
	present(): Promise<Presence[]>;
	/** Whether this session's pi runs a harness that knows the move. */
	knowsMove(presence: Presence): Promise<boolean>;
	/** The session's log, when pi saved one. */
	sessionFile(session: string): string | undefined;
	/** Whether a person wrote in that log, read only where no presence says. */
	personWrote(file: string): Promise<boolean>;
	/** Where the session's window stands now, or nothing when it has none. */
	window(presence: Presence): Promise<WindowStanding | undefined>;
	/** The session running the cutover, if a pi runs it. */
	readonly self?: string;
	/**
	 * Whether Joel is away from the machine at this moment. Only a run
	 * that may move his workspace while he is away asks; without it, a
	 * window on his workspace is always spared.
	 */
	joelAway?(): boolean;
}

/**
 * Why a session's window must be left where it stands, or nothing when
 * it may move: on Joel's focused workspace while he may be there, a
 * running pi no mycelium holds, whose window would close, or where
 * nobody can say. A parked pi no mycelium holds has no window to lose.
 * A move keeps its window in place (core #3179), so one on his
 * workspace may move once he is away (`joelAway`), never while he is
 * at the machine.
 */
export function windowSpares(
	window: WindowStanding | undefined,
	parked: boolean,
	joelAway = false,
): string | undefined {
	if (window?.where === "joel" && !joelAway)
		return "its window is on the workspace Joel has focused";
	if (window?.where === "unheld")
		return parked
			? undefined
			: "no mycelium holds it, so whatever window it has would close";
	if (typeof window?.where === "object")
		return `its window can't be placed, so may be Joel's: ${window.where.unplaced}`;
	return undefined;
}

/**
 * Whether `one` goes by a name in `names`, upper-cased: its session's id
 * or any of its addresses.
 */
export function goesBy(
	one: Pick<Presence, "session" | "addresses">,
	names: ReadonlySet<string>,
): boolean {
	return [one.session, ...one.addresses].some((name) =>
		names.has(name.toUpperCase()),
	);
}

/**
 * Where each live pi goes, or why it doesn't, in the order found; with
 * `only`, upper-cased names, every pi going by none of them stays.
 */
export async function planCutover(
	facts: CutoverFacts,
	overrides: HostOverrides = NO_OVERRIDES,
	only?: ReadonlySet<string>,
): Promise<Step[]> {
	const present = await facts.present();
	return Promise.all(
		present
			.filter((one) => one.hosted === undefined)
			.map(async (one): Promise<Step> => {
				const { session } = one;
				const address = one.addresses[0] ?? session;
				const leave = (why: string): Step => ({
					kind: "leave",
					session,
					address,
					why,
				});
				if (only && !goesBy(one, only)) return leave("not named in --only");
				if (one.machine !== undefined)
					return leave(`on ${one.machine}, left alone`);
				if (session === facts.self)
					return leave("runs this cutover; move it after");
				const file = facts.sessionFile(session);
				if (file === undefined) return leave("no saved log to take up");
				// A pi that knows the move says whether a person wrote in it; a
				// log is read only for a parked one whose presence predates that,
				// and never for a pi that must reload first, which will say.
				const knows = await facts.knowsMove(one);
				if (!knows)
					return {
						kind: "reload",
						session,
						address,
						why: "its harness predates the move",
					};
				const window = await facts.window(one);
				const away = facts.joelAway?.() ?? false;
				const spared = windowSpares(window, one.state === "parked", away);
				if (spared !== undefined) return leave(spared);
				const his =
					window?.where === "joel"
						? "; its window is on Joel's workspace, and he is away"
						: "";
				const wrote = one.driven ?? (await facts.personWrote(file));
				const choice = hostFor(one.addresses, wrote, overrides);
				const old =
					window?.loudHolder === undefined
						? ""
						: `; ${window.loudHolder}, so its window may show a Parked line for 2 to 5 s`;
				return {
					kind: "move",
					session,
					address,
					to: choice.kind,
					why: `${choice.why}${his}${old}`,
					parked: one.state === "parked",
				};
			}),
	);
}

/** One line of the plan, as the dry run and the run print it. */
export function stepLine(step: Step): string {
	const what =
		step.kind === "move"
			? `${step.parked ? "wake and move" : "move"} to ${step.to}`
			: step.kind === "reload"
				? "reload first"
				: "leave";
	return `${step.address.padEnd(8)}  ${what.padEnd(26)}  ${step.why}`;
}

/** What carrying the moves out asks of the machine; tests give their own. */
export interface MoveFacts {
	/**
	 * Ask the shell to keep the place of the session's window, so it opens
	 * the hosted viewer there once the host holds it (KP0L6A, 10 November);
	 * answers what the shell said.
	 */
	keepPlace(session: string): Promise<string>;
	/** Where the session's window stands at this moment, read afresh. */
	windowNow(session: string): Promise<WindowStanding | undefined>;
	/** Whether Joel is away at this moment, as CutoverFacts.joelAway. */
	joelAway?(): boolean;
	/** Tell a session to move, through its steer inbox. */
	tell(address: string, to: HostKind): void;
	/** Wake a parked session, so it takes its move. */
	wake(session: string): void;
	/** The move notes on disk. */
	notes(): MoveNote[];
	/** Take a note away once its session is adopted. */
	removeNote(session: string): void;
	/**
	 * Claim a session's note before asking a host to adopt its log, so a
	 * join taking the move back in the session's own window can't start
	 * `pi --session` beside the host: the note, or nothing once the join
	 * has it (lib/internal/session/move.ts claimMoveNote).
	 */
	claim(session: string): MoveNote | undefined;
	/** Give a claimed note back, as the host wouldn't adopt its log. */
	giveBack(session: string): void;
	/**
	 * Whether the host of `to` keeps a session on its roster, which it
	 * writes before it starts a conversation and resumes from when it
	 * starts again: a host that failed or died after that has the log.
	 */
	kept(session: string, to: HostKind): Promise<boolean>;
	/**
	 * Whether what wrote a note still has its session: the pi that wrote
	 * it, or for a note from a host, that host.
	 */
	running(note: MoveNote): Promise<boolean>;
	/** The sessions the hosts hold now, each by the key of the host holding it. */
	held(): Promise<ReadonlyMap<string, string>>;
	/** Ask a host to adopt a log; answers why not when it won't. */
	adopt(note: MoveNote, to: HostKind): Promise<string | undefined>;
	/** What holds a session still waiting to move, as its presence says. */
	holds(session: string): Promise<string | undefined>;
	/** The move a session's presence says was called off, while none waits. */
	calledOff(session: string): Promise<MoveOff | undefined>;
	now(): number;
	/** Wait a while before looking again. */
	pause(ms: number): Promise<void>;
	/** Say a step as it happens. */
	say(line: string): void;
}

/** How a run of moves ended. */
export interface MoveReport {
	/** The addresses of the sessions a host now holds. */
	readonly moved: readonly string[];
	/** Sessions still waiting at the deadline, with what holds each. */
	readonly waiting: readonly { address: string; holds?: string }[];
	/** Sessions a host wouldn't take, with why. */
	readonly refused: readonly { address: string; why: string }[];
	/** The addresses of the sessions their own window took back, running plain pi there. */
	readonly takenBack: readonly string[];
	/** Sessions whose move called itself off after this run told them, with why. */
	readonly calledOff: readonly { address: string; why: string }[];
	/** What the shell said of keeping each session's window's place. */
	readonly places: readonly { address: string; said: string }[];
	/** Sessions left untold, as their window stood just before, with why. */
	readonly spared: readonly { address: string; why: string }[];
}

/** What host-cutover prints of a carried-out report, a line each. */
export function reportLines(report: MoveReport): string[] {
	return [
		`${report.moved.length} moved.`,
		...report.waiting.map(
			(one) =>
				`still waiting: ${one.address}${one.holds ? `, ${one.holds}` : ""}`,
		),
		...report.spared.map((one) => `left untold: ${one.address}, ${one.why}`),
		...report.refused.map((one) => `not adopted: ${one.address}, ${one.why}`),
		...report.calledOff.map(
			(one) => `called its move off: ${one.address}, ${one.why}`,
		),
		...report.takenBack.map(
			(address) => `taken back in its own window: ${address}`,
		),
		...report.places
			.filter((one) => !one.said.startsWith("kept"))
			.map((one) => `window not kept: ${one.address}, ${one.said}`),
	];
}

/**
 * Whether a report leaves nothing for the person: none still waiting,
 * refused, called off or left untold. A session its own window took
 * back runs on in plain pi, as a release would leave it.
 */
export function carriedOutWhole(report: MoveReport): boolean {
	return (
		report.waiting.length === 0 &&
		report.refused.length === 0 &&
		report.calledOff.length === 0 &&
		report.spared.length === 0
	);
}

/** How often the cutover looks again while sessions are moving. */
export const LOOK_EVERY_MS = 2_000;

/**
 * Carry out the moves: tell each session, wake the parked, then adopt
 * each as its pi goes, until all are held or the deadline passes. A
 * move that called itself off since its tell is settled at once, with
 * why, rather than waited out. A note left by an earlier run whose
 * session isn't in this one is finished too: adopted when its pi has
 * gone, taken away when its session is already held. A release's notes
 * (to plain pi) are left to the release.
 */
export async function carryOut(
	steps: readonly MoveStep[],
	facts: MoveFacts,
	deadline: number,
): Promise<MoveReport> {
	const goes = new Map<string, HostKind>();
	const toldAt = new Map<string, number>();
	const places: { address: string; said: string }[] = [];
	const spared: { address: string; why: string }[] = [];
	for (const step of steps) {
		const why = windowSpares(
			await facts.windowNow(step.session),
			step.parked,
			facts.joelAway?.() ?? false,
		);
		if (why !== undefined) {
			spared.push({ address: step.address, why });
			facts.say(`left ${step.address} untold: ${why}`);
			continue;
		}
		const said = await facts.keepPlace(step.session);
		places.push({ address: step.address, said });
		facts.say(`${step.address}'s window: ${said}`);
		toldAt.set(step.session, facts.now());
		facts.tell(step.address, step.to);
		if (step.parked) facts.wake(step.session);
		goes.set(step.session, step.to);
		facts.say(`told ${step.address} to move to ${step.to}`);
	}
	const addresses = new Map(steps.map((step) => [step.session, step.address]));
	for (const note of facts.notes()) {
		if (note.to === "pi" || goes.has(note.session)) continue;
		goes.set(note.session, note.to);
		addresses.set(note.session, note.addresses[0] ?? note.session);
	}
	const moved: string[] = [];
	const takenBack: string[] = [];
	const calledOff: { address: string; why: string }[] = [];
	const refused = new Map<string, string>();
	const addressOf = (session: string) => addresses.get(session) ?? session;
	// The move a session this run told says it called off, and whether it
	// is the one this tell started, as when its holder couldn't be told
	// the join: no note will come, so waiting out the deadline would only
	// say it still waits. Which move it was is said by when it was asked,
	// which the session stamps as it reads the tell's steer, on this
	// machine's clock: one asked before the tell is an earlier move's,
	// which the tell replaces, even if it was called off since.
	const offOf = async (session: string) => {
		const told = toldAt.get(session);
		if (told === undefined) return undefined;
		const off = await facts.calledOff(session);
		return off === undefined
			? undefined
			: { why: off.why, ours: Date.parse(off.since) >= told };
	};
	for (;;) {
		const held = await facts.held();
		const notes = new Map(facts.notes().map((note) => [note.session, note]));
		for (const session of [...goes.keys()]) {
			const note = notes.get(session);
			// The host a conversation is leaving holds it until it goes, so
			// only another host holding it says it moved.
			const holder = held.get(session);
			if (holder !== undefined && holder !== note?.from) {
				if (note) facts.removeNote(session);
				goes.delete(session);
				refused.delete(session);
				moved.push(addressOf(session));
				facts.say(`${addressOf(session)} is held by the ${holder} host`);
				continue;
			}
			if (note === undefined) {
				const off = await offOf(session);
				if (off?.ours !== true) continue;
				const { why } = off;
				goes.delete(session);
				calledOff.push({ address: addressOf(session), why });
				facts.say(`${addressOf(session)} called its move off: ${why}`);
				continue;
			}
			if (note.to === "pi") continue;
			if (await facts.running(note)) continue;
			const claimed = facts.claim(session);
			if (claimed?.to === "pi") {
				// Written again as a release since it was read: the release's.
				facts.giveBack(session);
				continue;
			}
			if (claimed === undefined) {
				goes.delete(session);
				refused.delete(session);
				takenBack.push(addressOf(session));
				facts.say(`${addressOf(session)} taken back in its own window`);
				continue;
			}
			const why = await facts.adopt(claimed, claimed.to);
			if (why === undefined) {
				facts.removeNote(session);
				goes.delete(session);
				refused.delete(session);
				moved.push(addressOf(session));
				facts.say(`${addressOf(session)} adopted by the ${note.to} host`);
			} else if (await facts.kept(session, claimed.to)) {
				// Rostered before it failed or the host went: that host resumes
				// it, so giving the note back would let its window start a
				// second writer.
				facts.removeNote(session);
				goes.delete(session);
				refused.delete(session);
				moved.push(addressOf(session));
				facts.say(
					`${addressOf(session)} kept by the ${claimed.to} host, though ${why}`,
				);
			} else {
				facts.giveBack(session);
				if (refused.get(session) !== why) {
					refused.set(session, why);
					facts.say(`${addressOf(session)} not adopted yet: ${why}`);
				}
			}
		}
		if (goes.size === 0 || facts.now() >= deadline) break;
		await facts.pause(LOOK_EVERY_MS);
	}
	const waiting = await Promise.all(
		[...goes.keys()]
			.filter((session) => !refused.has(session))
			.map(async (session) => {
				const address = addressOf(session);
				// A call-off of an earlier move says this tell wasn't taken
				// up, not why this one stopped.
				const off = await offOf(session);
				const holds =
					off === undefined || off.ours
						? await facts.holds(session)
						: `it hasn't taken up this move; an earlier one called itself off: ${off.why}`;
				return holds ? { address, holds } : { address };
			}),
	);
	return {
		moved,
		waiting,
		places,
		spared,
		takenBack,
		calledOff,
		refused: [...refused].map(([session, why]) => ({
			address: addressOf(session),
			why,
		})),
	};
}
