/**
 * The host as its children's supervisor: it starts a child for a
 * conversation, watches what the child says of it, routes to it while
 * it runs, and takes its children up again when the host itself starts.
 *
 * A child is started into a slot (child-units.ts) and listens on the
 * slot's socket some seconds later, once its extensions have loaded. A
 * resumed conversation is named in the slot, so the child takes it up
 * by itself; a new one is asked of the child as its first request, an
 * open or an adopt, whose answer names the conversation. Either way the
 * host then watches the child, holds a route to it from the child's
 * first answer, moves the route when the conversation becomes another,
 * and lets the route and the slot go when the child says it ends: once
 * its unit has gone, stopped first when the watch failed and the child
 * may still run.
 *
 * A conversation's process may still be leaving a slot named by another
 * id, an open's or the one it became from, so the supervisor keeps the
 * slot each conversation last ran in, and a start waits for that slot
 * to empty as for its own. A slot whose unit can't be seen to go stays
 * in use, refusing a start, rather than start a second child beside one
 * that may still run; a start asks again, and frees it once it has gone.
 *
 * The shared roster is the supervisor's too, kept from the entry each
 * child sends: held from the child's first answer when it isn't held
 * already (an open, or one an earlier host opened but never held),
 * replaced when the conversation becomes another, and dropped only when
 * it is closed or released, so a parked or failed one is resumed later.
 * Each slot's file is written again with what the host holds for its
 * child, so a child an earlier host left that became another answers
 * under its new id, which replaces the one its slot names; the slot is
 * written before the roster, so a host ending between the two leaves
 * the next one holding a start of the new id back. A child that
 * contradicts itself or the roster is refused, or what it said passed
 * over, so no route or hold is taken from it; one whose became does is
 * stopped, since it runs that conversation whatever the host takes.
 *
 * A host stopping stops watching and leaves its children running, since
 * each is a unit of its own; the next host finds them by their slots and
 * watches them again, and clears a slot whose unit has gone. A resume
 * waits for the slot whose file names its conversation to be taken up,
 * not for every slot, so one busy child holds no other conversation's
 * start. What the stopping host had under way stops at its next step: a
 * start fails as the host's stop, and a child leaving is left to the
 * next host.
 *
 * Long because starting, watching, leaving and adopting each read and
 * change the same slots, routes and waits (`inUse`, `ranIn`, `leaving`,
 * `writing`, `takingFor`): a race between any two is closed only by
 * reading them all together, and split apart they would be one state
 * passed about.
 */
import { randomUUID } from "node:crypto";
import { setMaxListeners } from "node:events";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import type { RosterEntry } from "../../lib/core/session/roster.ts";
import { isRecord } from "../../lib/internal/record.ts";
import { carriedEnvironment } from "../../lib/internal/session/carried-environment.ts";
import { sessionAddress } from "../../lib/mesh/address.ts";
import { askOnce, madeByHost, reach } from "./child-requests.ts";
import {
	clearSlot,
	forsakeSlot,
	type Slot,
	slotForsaken,
	slotHolds,
	slotOf,
	slotsIn,
	slotWas,
	type Units,
	writeSlot,
} from "./child-units.ts";
import {
	type ChildEnding,
	type ChildWatch,
	Unanswered,
	type Watched,
	watchChild,
} from "./child-watch.ts";
import type { HeldChildren } from "./children.ts";
import type { ControlReply } from "./dispatch.ts";
import type { ControlRequest, SessionIdentity } from "./protocol.ts";
import type { HostRoster } from "./roster.ts";

/** The shared roster, as far as the supervisor keeps it. */
export type KeptRoster = Pick<
	HostRoster,
	"entries" | "hold" | "replace" | "drop"
>;

/**
 * How long a child may take to listen once its unit starts: one with
 * every extension took 8 to 13 s on 19 November, on a loaded machine.
 */
export const LISTENS_WITHIN_MS = 60_000;
/**
 * How long a listening child may take to answer its first request: an
 * open builds its conversation before it answers, so as long as a
 * child may take to listen.
 */
export const ANSWERS_WITHIN_MS = 60_000;
/**
 * How long a child that said it ends may take to exit before it is
 * stopped, and a stopped one to go before its slot is given up on.
 */
export const EXITS_WITHIN_MS = 30_000;
/**
 * How long a whole open or adopt may take, its child's listening, its
 * answer and any watch after: within the 120 s a caller waits on an open
 * (spawn-host.ts), so even a late answer reaches one still waiting.
 */
export const BEGINS_WITHIN_MS = 100_000;
/**
 * What a begin keeps back of its time to watch a child that gave its
 * request no answer, which may have built the conversation all the same.
 */
export const UNSETTLED_WITHIN_MS = 10_000;
/**
 * How many times a leaving child's unit is stopped and waited on before
 * its slot is left in use and the stop is left to whoever reads why.
 */
const STOP_TRIES = 3;
/**
 * How many times a host taking up a child tries its watch while the
 * child takes it but gives no answer: its thread may be busy with a
 * turn, which a stop would end.
 */
const WATCH_TRIES = 3;
/** How often a starting child's socket is tried until it listens. */
const TRIED_EVERY_MS = 100;
/** How often a starting child's unit is asked whether it still runs. */
const ASKED_EVERY_MS = 1_000;
/**
 * How soon a leaving child's unit is first asked whether it has gone,
 * each ask after waiting twice as long, up to LEFT_AT_MOST_MS, so many
 * children parking at once don't crowd the user's systemd.
 */
const LEFT_EVERY_MS = 250;
const LEFT_AT_MOST_MS = 2_000;
/** How much of why a child couldn't be watched goes in the journal. */
const SAID_CHARS = 300;
/** The longest a slot's name runs, as every conversation id does. */
const LONGEST_NAME = "00000000-0000-4000-8000-000000000000";

/** A request that starts a conversation, as a child takes it first. */
export type Beginning = Extract<ControlRequest, { op: "open" | "adopt" }>;

/** The host's children, as the host asks for them. */
export interface ChildSupervisor {
	/**
	 * Run a held conversation in a child of its own, settling once the
	 * child has it, or with the one already running it: `woken` when a
	 * wake of its park asked for it. A host adopts what its last left
	 * before it resumes anything, since a resume before the first adopt
	 * waits on no slot of the last host's, and could start a second child
	 * beside one running the conversation.
	 */
	resume(entry: RosterEntry, woken?: boolean): Promise<SessionIdentity>;
	/**
	 * Start a conversation in a child of its own, settling with the
	 * child's answer to `request` as the caller is told it, or with
	 * `open_unsettled` naming one it built but gave no answer for.
	 * Rejects when its child can't be started, watched or held, the host
	 * stops watching, or it adopts a file a conversation the host holds,
	 * routes or begins on already runs from, so a caller is told an error
	 * of the host's.
	 */
	begin(request: Beginning): Promise<ControlReply>;
	/**
	 * Watch every child an earlier host left running, and clear each
	 * slot whose unit has gone; settles with how many it took up. A
	 * second call while one runs settles with the first's count.
	 */
	adopt(): Promise<number>;
	/**
	 * Settles once no child runs this conversation: every one that ran it
	 * has gone and its own slot is free, or runs what it became. Fails
	 * while one still runs it, or once the host stops watching.
	 */
	left(sessionId: string): Promise<void>;
	/**
	 * Stop watching every child, leaving each running, one still being
	 * set up among them, whose start then fails at once as the host's stop.
	 */
	close(): void;
}

/** A child's refusal of the conversation it was asked to start. */
class RefusedBeginning extends Error {
	readonly reply: ControlReply;

	constructor(reply: ControlReply) {
		super("The child refused its first request");
		this.reply = reply;
	}
}

/** Whether an error says nothing listens at a socket yet. */
function notListening(error: unknown): boolean {
	const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
	return code === "ENOENT" || code === "ECONNREFUSED";
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The supervisor stopped watching while a child was being set up. */
class StoppedWatching extends Error {
	constructor() {
		super("The host stopped watching its children, leaving this one running");
	}
}

/** `error` as one quoted line of at most SAID_CHARS, for the journal. */
function quoted(error: unknown): string {
	return JSON.stringify(String(error).slice(0, SAID_CHARS));
}

/**
 * A conversation's id as the supervisor keys it: the roster takes an id
 * in either case, so two spellings must name one conversation.
 */
function keyed(sessionId: string): string {
	return sessionId.toLowerCase();
}

/** What a watch is to hold its child to. */
interface Holding {
	/** The conversation its first answer must name. */
	expected?: string;
	/** The conversation the slot's file says the host last held for it. */
	named?: string;
	/**
	 * The conversation the slot's file says `named` became from, which the
	 * roster may hold still if the last host ended before replacing it.
	 */
	was?: string;
	/** A new conversation, so one the roster holds already is refused. */
	fresh?: boolean;
	/**
	 * What the request that started it asked for, which its first hold
	 * keeps when the roster holds nothing it came from.
	 */
	asked?: Vouched;
	/** When the watch must have its answer by, as a time. */
	by?: number;
}

/**
 * What a child's roster entry can't vouch for itself: whether it is
 * attended, its quest, and the launch every resume replays, which
 * carries the fence. Each is kept from what the host held, or asked.
 */
type Vouched = Pick<RosterEntry, "attended" | "quest" | "launch">;

/**
 * `entry` with what the host vouches for taken from `base`, so no
 * child adds to or drops from what every later resume runs under. With
 * no base, as for a conversation the roster never held, its launch is
 * cut to the carried variables: it adds none, but may leave one out.
 */
function vouched(entry: RosterEntry, base: Vouched | undefined): RosterEntry {
	const { quest: _quest, launch: _launch, ...rest } = entry;
	const quest = base ? base.quest : entry.quest;
	const launch = base
		? base.launch
		: entry.launch && carriedEnvironment(entry.launch);
	return {
		...rest,
		attended: base ? base.attended : entry.attended,
		...(quest !== undefined ? { quest } : {}),
		...(launch !== undefined && Object.keys(launch).length > 0
			? { launch }
			: {}),
	};
}

/**
 * Supervise the children of the host keyed `key`, whose slots are in
 * `folder`; throws when a child's socket there would be too long a path.
 */
export function childSupervisor(options: {
	key: string;
	folder: string;
	units: Units;
	routes: HeldChildren;
	roster: KeptRoster;
	report: (error: unknown) => void;
	/** Writes a line to the host's journal, as each child ends. */
	say?: (line: string) => void;
	/** A child's conversation ended, as it said, its route already gone. */
	ended?: (sessionId: string, why: ChildEnding) => void;
	listensWithinMs?: number;
	answersWithinMs?: number;
	exitsWithinMs?: number;
	beginsWithinMs?: number;
	unsettledWithinMs?: number;
}): ChildSupervisor {
	const { roster, routes, units } = options;
	// Refused now rather than at each start, for a key too long to fit.
	slotOf(options.folder, options.key, LONGEST_NAME);
	const withinMs = options.listensWithinMs ?? LISTENS_WITHIN_MS;
	const answersWithinMs = options.answersWithinMs ?? ANSWERS_WITHIN_MS;
	const exitsWithinMs = options.exitsWithinMs ?? EXITS_WITHIN_MS;
	const beginsWithinMs = options.beginsWithinMs ?? BEGINS_WITHIN_MS;
	const unsettledWithinMs = options.unsettledWithinMs ?? UNSETTLED_WITHIN_MS;
	const watches = new Set<ChildWatch>();
	// Aborted as the host stops watching, ending each watch not yet answered.
	const stopping = new AbortController();
	// One listener for each watch not yet answered, which an adopt of many
	// children takes past Node's warning: none is a leak, since each goes
	// once its watch is answered or ended.
	setMaxListeners(0, stopping.signal);
	// Each begin's first request in flight, so a stop can end it.
	const asking = new Set<Socket>();
	// Each conversation a child is starting for, so two asks start one.
	const starting = new Map<string, Promise<SessionIdentity>>();
	// Each slot a child is set up in, runs in or leaves, by its unit.
	const inUse = new Set<string>();
	// Each slot whose child is leaving, until its unit has gone.
	const leaving = new Map<string, Promise<void>>();
	// The leave of the child that last ran each conversation, until its
	// unit has gone, which a wake of that conversation waits out.
	const leftBy = new Map<string, Promise<void>>();
	// Each forsaken slot's mark, by its unit, until it has been written or
	// failed to be, which its stop and the clearing of its slot wait on.
	const marking = new Map<string, Promise<void>>();
	// Units leaving with a grace to exit in, which a forsaking cuts short.
	const graced = new Set<string>();
	// Each graced leave's stop a forsaking hurried, which that leave waits
	// out before it frees the slot, so no stop outlives it into the next.
	const hurrying = new Map<string, Promise<void>>();
	// Each slot's claim under way, by its unit: a start's, from its check
	// that the slot is free until its unit has started, or a check that
	// frees it; so none clears a slot another has just taken.
	const claiming = new Map<string, Promise<unknown>>();
	// Each slot's clearing under way, which a second clearing joins.
	const releasing = new Map<string, Promise<void>>();
	// Each session file a begin adopts, until it settles.
	const adoptingFiles = new Set<string>();
	// The slots each conversation runs in or last left, by its keyed id
	// and then each slot's unit: a forsaken child may run one beside the
	// child the roster says runs it, and holds its start back as long.
	const ranIn = new Map<string, Map<string, Slot>>();
	// Each watch's queued slot and roster writes, by its unit, which a
	// clearing of its slot waits out, so none lands in the next child's.
	const writing = new Map<string, () => Promise<void>>();

	/** Count `sessionId` as running in `slot`, beside wherever else. */
	function runsIn(sessionId: string, slot: Slot): void {
		movedOff.delete(moveOf(sessionId, slot.unit));
		const slots = ranIn.get(keyed(sessionId)) ?? new Map<string, Slot>();
		slots.set(slot.unit, slot);
		ranIn.set(keyed(sessionId), slots);
	}

	// Each conversation a trusted answer or became moved off a slot, by
	// `moveOf`, so `left` passes a slot that now runs another one.
	const movedOff = new Set<string>();

	/** The key `movedOff` holds `sessionId` moved off `unit` by. */
	function moveOf(sessionId: string, unit: string): string {
		return `${keyed(sessionId)} ${unit}`;
	}

	/** Count `sessionId` as running in `slot` no longer, since it moved off. */
	function runsNoLongerIn(sessionId: string, slot: Slot): void {
		movedOff.add(moveOf(sessionId, slot.unit));
		const slots = ranIn.get(keyed(sessionId));
		slots?.delete(slot.unit);
		if (slots?.size === 0) ranIn.delete(keyed(sessionId));
	}
	// Each slot an adopt is taking up, by its unit and by the keyed id its
	// file names, so a start in it or for that conversation waits.
	const takingUnit = new Map<string, Promise<unknown>>();
	const takingFor = new Map<string, Promise<unknown>>();
	// An adopt listing its slots, which every start waits out.
	let listing: Promise<unknown> = Promise.resolve();
	// The adopt under way, which a second ask for one is given.
	let adopting: Promise<number> | undefined;
	let closing = false;

	/** Throws once the host has stopped watching, ending what it had under way. */
	function stillWatching(): void {
		if (closing) throw new StoppedWatching();
	}

	/** Whether the roster holds `sessionId`, in either case. */
	function held(sessionId: string): boolean {
		return heldAs(sessionId) !== undefined;
	}

	/**
	 * The id the roster holds `sessionId` under, in the roster's spelling,
	 * which it matches exactly, or undefined when it holds none or none
	 * is named.
	 */
	function heldAs(sessionId: string | undefined): string | undefined {
		return heldEntry(sessionId)?.sessionId;
	}

	/** The roster's entry for `sessionId`, in either case, if it holds one. */
	function heldEntry(sessionId: string | undefined): RosterEntry | undefined {
		if (sessionId === undefined) return undefined;
		return roster
			.entries()
			.find((entry) => keyed(entry.sessionId) === keyed(sessionId));
	}

	/**
	 * Whether a conversation the host holds, routes or begins on runs
	 * from `file`, so an adopt of it would run one conversation twice.
	 */
	function fileHeld(file: string): boolean {
		return (
			adoptingFiles.has(file) ||
			roster.entries().some((entry) => entry.file === file) ||
			routes.listed().some((running) => running.file === file)
		);
	}

	/**
	 * Run `claim` on `unit`'s slot once every claim on it before has
	 * settled, so a check that the slot is free and what takes it are one
	 * step to every other claim.
	 */
	function claimed<T>(unit: string, claim: () => Promise<T>): Promise<T> {
		const before = claiming.get(unit);
		const run = (async () => {
			await before;
			return claim();
		})();
		const settled = run.catch(() => undefined);
		claiming.set(unit, settled);
		void settled.then(() => {
			if (claiming.get(unit) === settled) claiming.delete(unit);
		});
		return run;
	}

	/** Whether a route to a child other than `slot`'s holds `sessionId`. */
	function elsewhere(slot: Slot, sessionId: string): boolean {
		return routes
			.listed()
			.some(
				(running) =>
					keyed(running.sessionId) === keyed(sessionId) &&
					routes.routeOf(running.sessionId)?.socket !== slot.socket,
			);
	}

	/**
	 * Try `attempt` until the child at its socket listens, the time runs
	 * out, by `by` when that comes sooner, its unit is found to have gone,
	 * asked once a second, or the host stops watching.
	 */
	async function once<T>(
		slot: Slot,
		attempt: () => Promise<T>,
		by = Number.POSITIVE_INFINITY,
	): Promise<T> {
		const ms = Math.max(0, Math.min(withinMs, by - Date.now()));
		const until = Date.now() + ms;
		let asked = Date.now();
		for (;;) {
			stillWatching();
			try {
				return await attempt();
			} catch (error) {
				if (!notListening(error)) throw error;
				if (Date.now() >= until)
					throw new Error(`${slot.unit} did not listen within ${ms} ms`);
			}
			if (Date.now() - asked >= ASKED_EVERY_MS) {
				asked = Date.now();
				// A systemd that can't say, as a loaded one may not, is no
				// sign the child has gone: it is given until the time runs out.
				if (await units.gone(slot.unit).catch(() => false))
					throw new Error(`${slot.unit} ended before it listened`);
			}
			await pause(TRIED_EVERY_MS);
		}
	}

	/**
	 * Whether `unit` goes within `ms`, asked less often the longer it
	 * takes; a host that stops watching meanwhile ends the wait.
	 */
	async function goneWithin(unit: string, ms: number): Promise<boolean> {
		const until = Date.now() + ms;
		let every = LEFT_EVERY_MS;
		for (;;) {
			stillWatching();
			if (await units.gone(unit)) return true;
			stillWatching();
			if (Date.now() >= until) return false;
			await pause(Math.min(every, Math.max(0, until - Date.now())));
			every = Math.min(every * 2, LEFT_AT_MOST_MS);
		}
	}

	/**
	 * Clear and free `slot`, whose unit has gone; a second ask while one
	 * runs joins it, so none clears what the slot's next child is given.
	 */
	function release(slot: Slot): Promise<void> {
		const already = releasing.get(slot.unit);
		if (already) return already;
		const clearing = (async () => {
			// A mark landing after the clear would forsake the slot's next child.
			await marking.get(slot.unit);
			// So does a write its watch queued, which would name it again; a
			// write that fails forsakes the child, queuing a mark behind it.
			await writing.get(slot.unit)?.();
			await marking.get(slot.unit);
			marking.delete(slot.unit);
			writing.delete(slot.unit);
			await clearSlot(slot);
			await units.forget(slot.unit);
			inUse.delete(slot.unit);
			for (const moved of [...movedOff])
				if (moved.endsWith(` ${slot.unit}`)) movedOff.delete(moved);
			for (const [sessionId, slots] of ranIn) {
				slots.delete(slot.unit);
				if (slots.size === 0) ranIn.delete(sessionId);
			}
		})().finally(() => releasing.delete(slot.unit));
		releasing.set(slot.unit, clearing);
		return clearing;
	}

	/**
	 * Whether `unit` has gone once stopped and waited on, each of
	 * STOP_TRIES tries on its own, so a systemd slow to answer once is
	 * asked again; a host that stops watching ends the tries.
	 */
	async function stopped(unit: string): Promise<boolean> {
		for (let tries = 1; tries <= STOP_TRIES; tries += 1) {
			stillWatching();
			try {
				await units.stop(unit);
				if (await goneWithin(unit, exitsWithinMs)) return true;
			} catch (error) {
				if (error instanceof StoppedWatching) throw error;
				options.say?.(`${unit}: its stop failed: ${quoted(error)}`);
				// A systemd that refused at once is given a moment to recover.
				if (tries < STOP_TRIES) await pause(LEFT_EVERY_MS * tries);
			}
		}
		// Asked once more, since the last try may have failed only to say.
		return ended(unit);
	}

	/**
	 * Whether `unit` has gone within `ms`, taking a systemd that fails to
	 * say as one whose unit may still run.
	 */
	async function goneOrUnsaid(unit: string, ms: number): Promise<boolean> {
		try {
			return await goneWithin(unit, ms);
		} catch (error) {
			if (error instanceof StoppedWatching) throw error;
			options.say?.(`${unit}: systemd didn't say: ${quoted(error)}`);
			return false;
		}
	}

	/** Whether `unit` has gone, as far as systemd will say now. */
	async function ended(unit: string): Promise<boolean> {
		stillWatching();
		return units.gone(unit).catch(() => false);
	}

	/**
	 * Let the child in `slot` go: stopped at once when `stopNow`, as for
	 * one whose watch failed and may still run, else given EXITS_WITHIN_MS
	 * to exit as it said it would, and its slot cleared and freed once its
	 * unit has gone, so nothing started in the slot meets the last one's
	 * files or the last one itself. A unit systemd can't be seen to stop
	 * after STOP_TRIES tries keeps its slot in use until a start finds it
	 * gone, and is reported with the command that stops it; a host that
	 * stops watching meanwhile leaves the slot to the next host's adopt.
	 * A forsaken child's stop waits on its mark; one forsaken while it
	 * is given its grace is stopped at once all the same, beside the leave,
	 * which waits that stop out before it frees the slot.
	 */
	function leave(slot: Slot, stopNow: boolean): Promise<void> {
		const already = leaving.get(slot.unit);
		if (already) {
			if (stopNow && graced.delete(slot.unit))
				hurrying.set(slot.unit, hurried(slot.unit));
			return already;
		}
		inUse.add(slot.unit);
		if (!stopNow) graced.add(slot.unit);
		const left = (async () => {
			await marking.get(slot.unit);
			// A systemd that can't say during the grace is no reason to
			// leave the child running: it is stopped, as one that overstayed.
			const exited = !stopNow && (await goneOrUnsaid(slot.unit, exitsWithinMs));
			// No stop is hurried once the grace is over, and one that was is
			// waited out, so none of its tries reaches the slot's next child.
			graced.delete(slot.unit);
			await hurrying.get(slot.unit);
			// A child forsaken since the leave began is stopped once marked.
			if (!exited) await marking.get(slot.unit);
			const went = exited || (await stopped(slot.unit));
			if (!went) {
				options.report(
					new Error(
						`${slot.unit} still runs, so its slot stays in use: ` +
							`systemctl --user stop ${slot.unit} ends it`,
					),
				);
				return;
			}
			await release(slot);
		})()
			.catch((error) => {
				if (!(error instanceof StoppedWatching)) options.report(error);
			})
			.finally(() => {
				leaving.delete(slot.unit);
				graced.delete(slot.unit);
				hurrying.delete(slot.unit);
			});
		leaving.set(slot.unit, left);
		return left;
	}

	/**
	 * Stop `unit`, once its mark is written, beside a leave already under
	 * way, which then finds it gone; what this stop can't do, that leave
	 * says.
	 */
	async function hurried(unit: string): Promise<void> {
		try {
			await marking.get(unit);
			await stopped(unit);
		} catch (error) {
			if (!(error instanceof StoppedWatching)) options.report(error);
		}
	}

	/**
	 * Whether `slot` may be started in: once nothing takes it up or leaves
	 * it, and its unit, if the slot is still in use, is asked again and
	 * found gone, which frees it.
	 */
	// The slot a start of this conversation would take, or nothing for an
	// id no slot can be named by, which no child of this host ever ran.
	function ownSlot(sessionId: string): Slot | undefined {
		try {
			return slotOf(options.folder, options.key, sessionId);
		} catch {
			// slotOf refuses only a name that isn't a conversation's id.
			return undefined;
		}
	}

	async function free(slot: Slot): Promise<boolean> {
		await takingUnit.get(slot.unit);
		await leaving.get(slot.unit);
		if (!inUse.has(slot.unit)) return true;
		if (!(await units.gone(slot.unit))) return false;
		await release(slot);
		return true;
	}

	/**
	 * Watch the child in `slot`, holding its route from its first answer,
	 * as `holding` asks. A child that names one conversation in its answer
	 * and another in its roster entry, one another child's route holds, or
	 * a new one's that the roster holds already, is refused, so no route or
	 * hold is taken from a child that disagrees with itself or another;
	 * so is one taken up that runs, in its slot's place, one the roster
	 * holds, as a became onto it would be.
	 * One that becomes such a conversation later, or whose became the
	 * roster won't hold, is forsaken: unrouted and stopped, with a resume
	 * of what it runs waiting for its slot to empty.
	 */
	async function watch(slot: Slot, holding: Holding = {}): Promise<ChildWatch> {
		const {
			expected,
			named,
			was: becameFrom,
			fresh,
			asked,
			by = Number.POSITIVE_INFINITY,
		} = holding;
		let current: string | undefined;
		let over = false;
		let refused: Error | undefined;
		let forsaken = false;
		/**
		 * Stop trusting the child, which now runs `running`: its route goes,
		 * and its slot is left at once, keeping whatever the roster holds.
		 */
		function forsake(running: string, why: string) {
			if (forsaken) return;
			forsaken = true;
			options.say?.(`${slot.unit}: stopped, since it ${why}`);
			if (current) dropOwn(current);
			current = undefined;
			markRunning(running);
			void leave(slot, true);
		}
		/**
		 * Hold a resume of `running` back until this slot empties, beside
		 * any other child that runs it, and mark the slot forsaken.
		 */
		function markRunning(running: string) {
			runsIn(running, slot);
			// Marked before it is stopped, so a host ending before the stop
			// takes leaves the next one to stop it rather than take it up;
			// and after the slot's writes queued already, which would erase it.
			const marked = kept.then(() => forsakeSlot(slot, running));
			kept = marked.catch(() => undefined);
			marking.set(
				slot.unit,
				marked.catch((error) => {
					// A mark that won't write is said, and the child stopped all the same.
					options.report(error);
				}),
			);
		}
		/** Drop the route `sessionId` holds, when it is to this child. */
		function dropOwn(sessionId: string) {
			if (routes.routeOf(sessionId)?.socket === slot.socket)
				routes.drop(sessionId);
		}
		// This child's roster changes, in the order it said them; the first,
		// its hold, fails the watch when the roster refuses it, since a
		// conversation the roster doesn't hold is resumed by no later host.
		let kept = Promise.resolve();
		let first: Promise<void> = Promise.resolve();
		function keep(change: () => Promise<void>) {
			kept = kept.then(change).catch(options.report);
		}
		writing.set(slot.unit, () => kept);
		function refusing({ conversation, entry }: Watched): string | undefined {
			const { sessionId } = conversation;
			if (expected !== undefined && keyed(sessionId) !== keyed(expected))
				return `runs ${sessionId}, not ${expected} as asked`;
			if (keyed(entry.sessionId) !== keyed(sessionId))
				return `runs ${sessionId} but holds ${entry.sessionId}`;
			if (elsewhere(slot, sessionId))
				return `runs ${sessionId}, which another child runs`;
			// A slot's file is written before the roster changes, so a hold of
			// what its file doesn't name is no hold this child took.
			const moved = named === undefined || keyed(named) !== keyed(sessionId);
			if (moved && held(sessionId))
				return fresh
					? `opened ${sessionId}, which the roster holds already`
					: `runs ${sessionId}, which the roster holds already, not ${named ?? "what its slot named"}`;
			return undefined;
		}
		const watching = await once(
			slot,
			() =>
				watchChild(
					slot.socket,
					Math.max(1, Math.min(answersWithinMs, by - Date.now())),
					{
						watched(answer) {
							const { host, conversation, entry } = answer;
							const why = refusing(answer);
							if (why) {
								refused = new Error(`${slot.unit} ${why}`);
								// It runs what it answered until it is stopped, so a
								// resume of that waits, and a later host stops it.
								markRunning(conversation.sessionId);
								return;
							}
							const { sessionId } = conversation;
							current = sessionId;
							const moved =
								named === undefined || keyed(named) !== keyed(sessionId);
							// What its file named runs here no longer.
							if (moved && named !== undefined) runsNoLongerIn(named, slot);
							runsIn(sessionId, slot);
							routes.hold(conversation, {
								socket: slot.socket,
								identity: host,
							});
							first = kept.then(async () => {
								// What the roster holds of where it came from: what its
								// slot names, or what that became from, as a host ending
								// between naming a became and replacing it leaves it.
								const from = heldAs(named) ?? heldAs(becameFrom);
								const holds = vouched(
									entry,
									from !== undefined ? heldEntry(from) : asked,
								);
								// Named first, with what it was, so a host ending
								// before the roster changes leaves the next one's adopt
								// holding a start of it back and replacing what it was,
								// rather than holding both.
								if (moved) await writeSlot(slot, holds, false, named);
								if (!held(sessionId)) {
									if (from !== undefined) await roster.replace(from, holds);
									else await roster.hold(holds);
								}
							});
							// Its failure is the watch's, thrown below.
							kept = first.catch(() => undefined);
						},
						state: (conversation) => {
							if (conversation.sessionId === current)
								routes.update(conversation);
						},
						became(previousId, conversation, entry) {
							const next = conversation.sessionId;
							// A child speaks for its own conversation alone, and
							// can't become one the roster or another child has.
							const its =
								current !== undefined && keyed(previousId) === keyed(current);
							const why = !its
								? `said ${previousId} became another, but runs ${current}`
								: keyed(entry.sessionId) !== keyed(next)
									? `said ${previousId} became ${next}, but holds ${entry.sessionId}`
									: elsewhere(slot, next)
										? `said ${previousId} became ${next}, which another child runs`
										: keyed(next) !== keyed(previousId) && held(next)
											? `said ${previousId} became ${next}, which the roster holds already`
											: undefined;
							if (forsaken) return;
							if (why) {
								options.report(new Error(`${slot.unit} ${why}`));
								// Word on another conversation is passed over; one that
								// left its own runs `next` all the same, wherever else.
								if (its) forsake(next, why);
								return;
							}
							// Its route and hold are under the spelling first answered.
							const left = current ?? previousId;
							const was = routes.routeOf(left);
							dropOwn(left);
							runsNoLongerIn(left, slot);
							current = next;
							runsIn(next, slot);
							if (was) routes.hold(conversation, was);
							keep(async () => {
								try {
									// It keeps what the host held of what it was.
									const before = heldEntry(left);
									const holds = vouched(entry, before);
									// Named first, as a first answer's is, with what it
									// was, so a host ending before the roster changes
									// leaves the next one to replace it, not hold both.
									await writeSlot(slot, holds, false, left);
									if (before) await roster.replace(before.sessionId, holds);
									else await roster.hold(holds);
								} catch (error) {
									// Unheld, so stopped: nothing runs a conversation no
									// later host would resume.
									if (current === next)
										forsake(next, `became ${next}, which couldn't be held`);
									throw error;
								}
							});
						},
						ended(why) {
							over = true;
							// A forsaken child is left already, and said nothing true.
							if (forsaken) return;
							if (current) dropOwn(current);
							// One refused as it ended may run on: it is stopped.
							const left = leave(
								slot,
								why === "failed" || refused !== undefined,
							);
							if (!current) return;
							const gone = current;
							leftBy.set(keyed(gone), left);
							void left.then(() => {
								if (leftBy.get(keyed(gone)) === left)
									leftBy.delete(keyed(gone));
							});
							if (why === "closed" || why === "released")
								keep(() => roster.drop(heldAs(gone) ?? gone));
							options.say?.(
								`${sessionAddress(current)} (${current}): its process ended, ${why}`,
							);
							options.ended?.(current, why);
						},
						misread: (error) =>
							options.report(new Error(`${slot.unit} ${error.message}`)),
					},
					stopping.signal,
				),
			by,
		);
		try {
			if (refused) throw refused;
			stillWatching();
			// Held before anyone is told the child has it.
			await first;
			await kept;
			// A stop while the hold was written: no watch is left behind it.
			stillWatching();
		} catch (error) {
			watching.close();
			if (current) dropOwn(current);
			throw error;
		}
		// One that ended as it answered is watched no longer.
		if (!over) {
			watches.add(watching);
			void closedOn(watching);
		}
		return watching;
	}
	/** Forget a watch once its child has ended. */
	async function closedOn(watching: ChildWatch) {
		await watching.closed;
		watches.delete(watching);
	}

	/**
	 * Start the child in `slot` and settle with what `work` makes of it,
	 * once the last child to run there has left it; a child that never
	 * gets that far is stopped, without waiting on its stop, and its slot
	 * cleared, so no conversation runs where nothing watches it, unless
	 * the host stopped watching, which leaves every child running for the
	 * next host to take up.
	 */
	async function inSlot<T>(
		slot: Slot,
		session: RosterEntry | undefined,
		woken: boolean,
		work: () => Promise<T>,
	): Promise<T> {
		// Taken only once free, so a slot another child runs in is left be.
		let taken = false;
		try {
			await claimed(slot.unit, async () => {
				if (!(await free(slot)))
					throw new Error(`A child runs in ${slot.unit} already`);
				inUse.add(slot.unit);
				taken = true;
				stillWatching();
				await writeSlot(slot, session, woken);
				await units.start(slot.unit);
			});
			return await work();
		} catch (error) {
			if (taken && !closing) void leave(slot, true);
			throw error;
		}
	}

	async function started(
		entry: RosterEntry,
		woken: boolean,
	): Promise<SessionIdentity> {
		await listing;
		const { sessionId } = entry;
		await takingFor.get(keyed(sessionId));
		const running = routes
			.listed()
			.find((held) => keyed(held.sessionId) === keyed(sessionId));
		if (running) return running;
		const slot = slotOf(options.folder, options.key, sessionId);
		// Its last process may be leaving a slot named by another id, and
		// a forsaken one may run it still.
		for (const last of [...(ranIn.get(keyed(sessionId))?.values() ?? [])])
			if (
				last.unit !== slot.unit &&
				!(await claimed(
					last.unit,
					// A start there since may have freed the slot of it already.
					async () =>
						!ranIn.get(keyed(sessionId))?.has(last.unit) || free(last),
				))
			)
				throw new Error(`${sessionId} still runs in ${last.unit}`);
		return inSlot(
			slot,
			entry,
			woken,
			async () =>
				(await watch(slot, { expected: sessionId, named: sessionId }))
					.conversation,
		);
	}

	/**
	 * Watch the child an earlier host left in `slot`, held for `named`
	 * when its file says so, or clear the slot if its unit has gone. The
	 * slot is in use from the first ask, and its conversation counted as
	 * running there, so a start of it waits for the slot to empty. A unit
	 * systemd won't say has gone is watched, as one running is. A child
	 * that takes its watch but gives no answer is tried again, as a busy
	 * one may be; one that can't be watched is let go without waiting on
	 * it, and a start in its slot, or of its conversation, waits for it.
	 */
	async function takeUp(
		slot: Slot,
		named: string | undefined,
		forsaken: boolean,
		was?: string,
	): Promise<boolean> {
		inUse.add(slot.unit);
		if (named !== undefined) runsIn(named, slot);
		if (await units.gone(slot.unit).catch(() => false)) {
			await leave(slot, false);
			return false;
		}
		if (forsaken) {
			options.say?.(`${slot.unit}: stopped, since an earlier host forsook it`);
			void leave(slot, true);
			return false;
		}
		for (let tries = 1; ; tries += 1) {
			try {
				await watch(slot, { named, was });
				return true;
			} catch (error) {
				if (closing) throw error;
				if (error instanceof Unanswered && tries < WATCH_TRIES) {
					options.say?.(
						`${slot.unit}: gave its watch no answer, try ${tries} of ${WATCH_TRIES}`,
					);
					continue;
				}
				// A child nothing can watch runs a conversation nothing can
				// reach, such as one an earlier host never finished opening:
				// it is stopped, and its conversation waits in the roster.
				options.say?.(
					`${slot.unit}: stopped, since it could not be watched: ${quoted(error)}`,
				);
				void leave(slot, true);
				throw error;
			}
		}
	}

	/**
	 * What a caller is told when the host found no answer from its child
	 * to its first request: the child may have built the conversation all
	 * the same, so it is watched until `by`. One it runs is held and
	 * named, so the caller attaches to it rather than opening a second;
	 * one that can't be watched is stopped, with `reply` as its answer.
	 */
	async function unsettled(
		slot: Slot,
		request: Beginning,
		reply: ControlReply,
		holding: Holding,
	): Promise<ControlReply> {
		let watching: ChildWatch;
		try {
			watching = await watch(slot, holding);
		} catch (error) {
			if (error instanceof StoppedWatching) throw error;
			throw new RefusedBeginning(reply);
		}
		const { sessionId } = watching.conversation;
		return {
			v: 1,
			id: request.id,
			ok: false,
			error: {
				code: "open_unsettled",
				message: `The conversation's process gave no answer in time, but runs ${sessionId}: attach to it, or close it, rather than open another`,
			},
		};
	}

	/** Ask the child at `slot` its first request, before `by`, as a stop can end. */
	async function firstAsked(
		slot: Slot,
		request: Beginning,
		by: number,
	): Promise<ControlReply> {
		const child = await once(slot, () => reach(slot.socket), by);
		try {
			stillWatching();
		} catch (error) {
			child.destroy();
			throw error;
		}
		// The caller named this host, which checked it; the child has no
		// identity the caller could know yet.
		const { expectedHost: _checked, ...asked } = request;
		asking.add(child);
		try {
			return await askOnce(
				child,
				`${JSON.stringify(asked)}\n`,
				request.id,
				options.report,
				Math.max(
					1,
					Math.min(answersWithinMs, by - unsettledWithinMs - Date.now()),
				),
			);
		} finally {
			asking.delete(child);
		}
	}

	/** Take up every child an earlier host left, as `adopt` says. */
	async function adoptAll(): Promise<number> {
		const taking = (async () => {
			const slots = (await slotsIn(options.folder, options.key)).filter(
				(slot) => !inUse.has(slot.unit),
			);
			// Each in use before its file is read, so nothing starts in it.
			for (const slot of slots) inUse.add(slot.unit);
			const [names, forsook, becameFrom] = await Promise.all([
				Promise.all(slots.map(slotHolds)),
				Promise.all(slots.map(slotForsaken)),
				Promise.all(slots.map(slotWas)),
			]);
			// What a forsaken child ran holds a start of it back until it
			// has gone, beside another child's slot that names it, as a
			// forsake in a host does; that one's take-up is what a start waits
			// on first.
			const namedElsewhere = (runs: string, at: number) =>
				names.some(
					(name, other) =>
						other !== at && name !== undefined && keyed(name) === keyed(runs),
				);
			return slots.map((slot, at) => {
				const forsaken = forsook[at];
				const named = forsaken ? forsaken.runs : names[at];
				const was = forsaken ? undefined : becameFrom[at];
				const taken = takeUp(slot, named, forsaken !== undefined, was);
				const settled = taken.catch(() => undefined);
				const waitedFor =
					named !== undefined && !(forsaken && namedElsewhere(named, at))
						? keyed(named)
						: undefined;
				takingUnit.set(slot.unit, settled);
				if (waitedFor) takingFor.set(waitedFor, settled);
				void settled.then(() => {
					takingUnit.delete(slot.unit);
					if (waitedFor) takingFor.delete(waitedFor);
				});
				return taken;
			});
		})();
		listing = taking.catch(() => undefined);
		const taken = await Promise.allSettled(await taking);
		let count = 0;
		for (const outcome of taken) {
			// A host that stopped watching leaves the child to the next one.
			if (outcome.status === "rejected") {
				if (!(outcome.reason instanceof StoppedWatching))
					options.report(outcome.reason);
			} else if (outcome.value) count += 1;
		}
		return count;
	}

	return {
		resume(entry, woken = false) {
			const { sessionId } = entry;
			const already = starting.get(keyed(sessionId));
			if (already) return already;
			const start = started(entry, woken).finally(() =>
				starting.delete(keyed(sessionId)),
			);
			starting.set(keyed(sessionId), start);
			return start;
		},
		begin(request) {
			const by = Date.now() + beginsWithinMs;
			const slot = slotOf(options.folder, options.key, randomUUID());
			// An adopt's file, too, must be one no host holds: one the roster
			// holds is resumed in the slot its own id names, never begun beside,
			// so it is refused before any child opens it.
			const fresh = true;
			const file =
				request.op === "adopt" ? resolve(request.sessionFile) : undefined;
			if (file !== undefined && fileHeld(file))
				return Promise.reject(new Error(`Conversation already held: ${file}`));
			if (file !== undefined) adoptingFiles.add(file);
			const asked: Vouched = {
				attended: request.attended,
				...(request.quest !== undefined ? { quest: request.quest } : {}),
				...(request.env !== undefined ? { launch: request.env } : {}),
			};
			return inSlot(slot, undefined, false, async () => {
				const reply = await firstAsked(slot, request, by);
				// A stop during the ask ends it, and the begin with it.
				stillWatching();
				if (!reply.ok && madeByHost(reply))
					return unsettled(slot, request, reply, { fresh, asked, by });
				// A child that couldn't start its conversation is stopped.
				if (!reply.ok) throw new RefusedBeginning(reply);
				// The watch must name what the answer named.
				const { result } = reply;
				const answered = isRecord(result) ? result.sessionId : undefined;
				const expected = typeof answered === "string" ? answered : "";
				await watch(slot, { expected, fresh, asked, by });
				return reply;
			})
				.catch((error) => {
					if (error instanceof RefusedBeginning) return error.reply;
					throw error;
				})
				.finally(() => {
					if (file !== undefined) adoptingFiles.delete(file);
				});
		},
		adopt() {
			adopting ??= adoptAll().finally(() => {
				adopting = undefined;
			});
			return adopting;
		},
		async left(sessionId) {
			await listing;
			await takingFor.get(keyed(sessionId));
			await leftBy.get(keyed(sessionId));
			// Every slot that ran it, whichever way its child left, until that
			// slot is free: one whose unit still runs refuses, as a start does.
			for (const last of [...(ranIn.get(keyed(sessionId))?.values() ?? [])]) {
				stillWatching();
				if (
					!(await claimed(
						last.unit,
						async () =>
							!ranIn.get(keyed(sessionId))?.has(last.unit) || free(last),
					))
				)
					throw new Error(`${sessionId} still runs in ${last.unit}`);
			}
			// Its own slot too: a child that failed before its first answer
			// ran in no slot the host heard of, and may be stopping still. One
			// whose child answered as, or became, another conversation runs
			// that one, not this; a refused answer moves nothing off it.
			const own = ownSlot(sessionId);
			if (own !== undefined && !movedOff.has(moveOf(sessionId, own.unit))) {
				stillWatching();
				if (!(await claimed(own.unit, () => free(own))))
					throw new Error(`${sessionId} still runs in ${own.unit}`);
			}
			stillWatching();
		},
		close() {
			closing = true;
			stopping.abort(new StoppedWatching());
			for (const watching of watches) watching.close();
			watches.clear();
			for (const child of asking) child.destroy();
		},
	};
}
