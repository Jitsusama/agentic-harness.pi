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
 */

import type { MoveNote } from "../../lib/internal/session/move.ts";
import type { Presence } from "../../lib/mesh/presence.ts";
import type { HostKind } from "../service/address.ts";
import { type HostOverrides, hostFor, NO_OVERRIDES } from "./attended.ts";

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
	/** The session running the cutover, if a pi runs it. */
	readonly self?: string;
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
				const wrote = one.driven ?? (await facts.personWrote(file));
				const choice = hostFor(one.addresses, wrote, overrides);
				return {
					kind: "move",
					session,
					address,
					to: choice.kind,
					why: choice.why,
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
	/** Tell a session to move, through its steer inbox. */
	tell(address: string, to: HostKind): void;
	/** Wake a parked session, so it takes its move. */
	wake(session: string): void;
	/** The move notes on disk. */
	notes(): MoveNote[];
	/** Take a note away once its session is adopted. */
	removeNote(session: string): void;
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
	/** What the shell said of keeping each session's window's place. */
	readonly places: readonly { address: string; said: string }[];
}

/** How often the cutover looks again while sessions are moving. */
export const LOOK_EVERY_MS = 2_000;

/**
 * Carry out the moves: tell each session, wake the parked, then adopt
 * each as its pi goes, until all are held or the deadline passes. A
 * note left by an earlier run whose session isn't in this one is
 * finished too: adopted when its pi has gone, taken away when its
 * session is already held. A release's notes (to plain pi) are left to
 * the release.
 */
export async function carryOut(
	steps: readonly MoveStep[],
	facts: MoveFacts,
	deadline: number,
): Promise<MoveReport> {
	const goes = new Map<string, HostKind>();
	const places: { address: string; said: string }[] = [];
	for (const step of steps) {
		const said = await facts.keepPlace(step.session);
		places.push({ address: step.address, said });
		facts.say(`${step.address}'s window: ${said}`);
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
	const refused = new Map<string, string>();
	const addressOf = (session: string) => addresses.get(session) ?? session;
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
			if (note === undefined || note.to === "pi") continue;
			if (await facts.running(note)) continue;
			const why = await facts.adopt(note, note.to);
			if (why === undefined) {
				facts.removeNote(session);
				goes.delete(session);
				refused.delete(session);
				moved.push(addressOf(session));
				facts.say(`${addressOf(session)} adopted by the ${note.to} host`);
			} else if (refused.get(session) !== why) {
				refused.set(session, why);
				facts.say(`${addressOf(session)} not adopted yet: ${why}`);
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
				const holds = await facts.holds(session);
				return holds ? { address, holds } : { address };
			}),
	);
	return {
		moved,
		waiting,
		places,
		refused: [...refused].map(([session, why]) => ({
			address: addressOf(session),
			why,
		})),
	};
}
