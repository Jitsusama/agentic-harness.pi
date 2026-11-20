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
 * under its new id, which replaces the one its slot names. A child that
 * contradicts itself or the roster is refused, or what it said passed
 * over, so no route or hold is taken from it.
 *
 * A host stopping stops watching and leaves its children running, since
 * each is a unit of its own; the next host finds them by their slots and
 * watches them again, and clears a slot whose unit has gone. A resume
 * waits for the slot whose file names its conversation to be taken up,
 * not for every slot, so one busy child holds no other conversation's
 * start. What the stopping host had under way stops at its next step: a
 * start fails as the host's stop, and a child leaving is left to the
 * next host.
 */
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { RosterEntry } from "../../lib/core/session/roster.ts";
import { isRecord } from "../../lib/internal/record.ts";
import { sessionAddress } from "../../lib/mesh/address.ts";
import { askOnce, madeByHost, reach } from "./child-requests.ts";
import {
	clearSlot,
	type Slot,
	slotHolds,
	slotOf,
	slotsIn,
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
const UNSETTLED_WITHIN_MS = 10_000;
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
	 * wake of its park asked for it.
	 */
	resume(entry: RosterEntry, woken?: boolean): Promise<SessionIdentity>;
	/**
	 * Start a conversation in a child of its own, settling with the
	 * child's answer to `request` as the caller is told it.
	 */
	begin(request: Beginning): Promise<ControlReply>;
	/**
	 * Watch every child an earlier host left running, and clear each
	 * slot whose unit has gone; settles with how many it took up.
	 */
	adopt(): Promise<number>;
	/**
	 * Stop watching every child, leaving each running, one still being
	 * set up among them, whose start then fails as the host's stop.
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
	/** A new conversation, so one the roster holds already is refused. */
	fresh?: boolean;
	/** When the watch must have its answer by, as a time. */
	by?: number;
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
}): ChildSupervisor {
	const { roster, routes, units } = options;
	// Refused now rather than at each start, for a key too long to fit.
	slotOf(options.folder, options.key, LONGEST_NAME);
	const withinMs = options.listensWithinMs ?? LISTENS_WITHIN_MS;
	const answersWithinMs = options.answersWithinMs ?? ANSWERS_WITHIN_MS;
	const exitsWithinMs = options.exitsWithinMs ?? EXITS_WITHIN_MS;
	const beginsWithinMs = options.beginsWithinMs ?? BEGINS_WITHIN_MS;
	const watches = new Set<ChildWatch>();
	// Each begin's first request in flight, so a stop can end it.
	const asking = new Set<Socket>();
	// Each conversation a child is starting for, so two asks start one.
	const starting = new Map<string, Promise<SessionIdentity>>();
	// Each slot a child is set up in, runs in or leaves, by its unit.
	const inUse = new Set<string>();
	// Each slot whose child is leaving, until its unit has gone.
	const leaving = new Map<string, Promise<void>>();
	// The slot each conversation runs in or last left, by its keyed id.
	const ranIn = new Map<string, Slot>();
	// Each slot an adopt is taking up, by its unit and by the keyed id its
	// file names, so a start in it or for that conversation waits.
	const takingUnit = new Map<string, Promise<unknown>>();
	const takingFor = new Map<string, Promise<unknown>>();
	// An adopt listing its slots, which every start waits out.
	let listing: Promise<unknown> = Promise.resolve();
	let closing = false;

	/** Throws once the host has stopped watching, ending what it had under way. */
	function stillWatching(): void {
		if (closing) throw new StoppedWatching();
	}

	/** Whether the roster holds `sessionId`, in either case. */
	function held(sessionId: string): boolean {
		return roster
			.entries()
			.some((entry) => keyed(entry.sessionId) === keyed(sessionId));
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
				if (await units.gone(slot.unit))
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

	/** Clear and free `slot`, whose unit has gone. */
	async function release(slot: Slot): Promise<void> {
		await clearSlot(slot);
		await units.forget(slot.unit);
		inUse.delete(slot.unit);
		for (const [sessionId, ran] of ranIn)
			if (ran.unit === slot.unit) ranIn.delete(sessionId);
	}

	/**
	 * Let the child in `slot` go: stopped at once when `stopNow`, as for
	 * one whose watch failed and may still run, else given EXITS_WITHIN_MS
	 * to exit as it said it would, and its slot cleared and freed once its
	 * unit has gone, so nothing started in the slot meets the last one's
	 * files or the last one itself. A unit systemd can't be seen to stop
	 * keeps its slot in use until a start finds it gone; a host that stops
	 * watching meanwhile leaves the slot to the next host's adopt.
	 */
	function leave(slot: Slot, stopNow: boolean): Promise<void> {
		const already = leaving.get(slot.unit);
		if (already) return already;
		inUse.add(slot.unit);
		const left = (async () => {
			if (stopNow || !(await goneWithin(slot.unit, exitsWithinMs))) {
				stillWatching();
				await units.stop(slot.unit);
			}
			if (!(await goneWithin(slot.unit, exitsWithinMs))) {
				options.report(
					new Error(`${slot.unit} still runs, so its slot stays in use`),
				);
				return;
			}
			await release(slot);
		})()
			.catch((error) => {
				if (!(error instanceof StoppedWatching)) options.report(error);
			})
			.finally(() => leaving.delete(slot.unit));
		leaving.set(slot.unit, left);
		return left;
	}

	/**
	 * Whether `slot` may be started in: once nothing takes it up or leaves
	 * it, and its unit, if the slot is still in use, is asked again and
	 * found gone, which frees it.
	 */
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
	 * an open's that the roster holds already, is refused, so no route or
	 * hold is taken from a child that disagrees with itself or another.
	 */
	async function watch(slot: Slot, holding: Holding = {}): Promise<ChildWatch> {
		const { expected, named, fresh, by = Number.POSITIVE_INFINITY } = holding;
		let current: string | undefined;
		let over = false;
		let refused: Error | undefined;
		// This child's roster changes, in the order it said them; the first,
		// its hold, fails the watch when the roster refuses it, since a
		// conversation the roster doesn't hold is resumed by no later host.
		let kept = Promise.resolve();
		let first: Promise<void> = Promise.resolve();
		function keep(change: () => Promise<void>) {
			kept = kept.then(change).catch(options.report);
		}
		function refusing({ conversation, entry }: Watched): string | undefined {
			const { sessionId } = conversation;
			if (expected !== undefined && sessionId !== expected)
				return `runs ${sessionId}, not ${expected} as asked`;
			if (entry.sessionId !== sessionId)
				return `runs ${sessionId} but holds ${entry.sessionId}`;
			if (elsewhere(slot, sessionId))
				return `runs ${sessionId}, which another child runs`;
			if (fresh && held(sessionId))
				return `opened ${sessionId}, which the roster holds already`;
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
								return;
							}
							const { sessionId } = conversation;
							current = sessionId;
							ranIn.set(keyed(sessionId), slot);
							routes.hold(conversation, {
								socket: slot.socket,
								identity: host,
							});
							const moved = named === undefined || named !== sessionId;
							first = kept.then(async () => {
								if (!held(sessionId)) {
									// One that became another while nothing watched it.
									if (moved && named !== undefined && held(named))
										await roster.replace(named, entry);
									else await roster.hold(entry);
								}
								// So the next host knows which id to replace.
								if (moved) await writeSlot(slot, entry);
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
							const why =
								previousId !== current
									? `said ${previousId} became another, but runs ${current}`
									: entry.sessionId !== next
										? `said ${previousId} became ${next}, but holds ${entry.sessionId}`
										: elsewhere(slot, next)
											? `said ${previousId} became ${next}, which another child runs`
											: keyed(next) !== keyed(previousId) && held(next)
												? `said ${previousId} became ${next}, which the roster holds already`
												: undefined;
							if (why) {
								options.report(new Error(`${slot.unit} ${why}`));
								return;
							}
							const was = routes.routeOf(previousId);
							routes.drop(previousId);
							ranIn.delete(keyed(previousId));
							current = next;
							ranIn.set(keyed(next), slot);
							if (was) routes.hold(conversation, was);
							keep(async () => {
								try {
									if (held(previousId)) await roster.replace(previousId, entry);
									else await roster.hold(entry);
								} catch (error) {
									// Unheld, so unrouted: nothing reaches a conversation
									// no later host would resume.
									if (current === next) routes.drop(next);
									throw error;
								}
								await writeSlot(slot, entry);
							});
						},
						ended(why) {
							over = true;
							if (current) routes.drop(current);
							// One refused as it ended may run on: it is stopped.
							void leave(slot, why === "failed" || refused !== undefined);
							if (!current) return;
							const gone = current;
							if (why === "closed" || why === "released")
								keep(() => roster.drop(gone));
							options.say?.(
								`${sessionAddress(current)} (${current}): its process ended, ${why}`,
							);
							options.ended?.(current, why);
						},
						misread: (error) =>
							options.report(new Error(`${slot.unit} ${error.message}`)),
					},
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
			if (current) routes.drop(current);
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
		if (!(await free(slot)))
			throw new Error(`A child runs in ${slot.unit} already`);
		inUse.add(slot.unit);
		try {
			stillWatching();
			await writeSlot(slot, session, woken);
			await units.start(slot.unit);
			return await work();
		} catch (error) {
			if (closing) inUse.delete(slot.unit);
			else void leave(slot, true);
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
		// Its last process may be leaving a slot named by another id.
		const last = ranIn.get(keyed(sessionId));
		if (last && last.unit !== slot.unit && !(await free(last)))
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
	 * slot is in use from the first ask, so a systemd that won't answer
	 * keeps it so. A child that takes its watch but gives no answer is
	 * tried again, as a busy one may be; one that can't be watched is let
	 * go without waiting on it, and a start in its slot waits for it.
	 */
	async function takeUp(
		slot: Slot,
		named: string | undefined,
	): Promise<boolean> {
		inUse.add(slot.unit);
		if (await units.gone(slot.unit)) {
			await leave(slot, false);
			return false;
		}
		for (let tries = 1; ; tries += 1) {
			try {
				await watch(slot, { named });
				return true;
			} catch (error) {
				if (closing) throw error;
				if (error instanceof Unanswered && tries < WATCH_TRIES) continue;
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
					Math.min(answersWithinMs, by - UNSETTLED_WITHIN_MS - Date.now()),
				),
			);
		} finally {
			asking.delete(child);
		}
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
			const fresh = request.op === "open";
			return inSlot(slot, undefined, false, async () => {
				const reply = await firstAsked(slot, request, by);
				// A stop during the ask ends it, and the begin with it.
				stillWatching();
				if (!reply.ok && madeByHost(reply))
					return unsettled(slot, request, reply, { fresh, by });
				// A child that couldn't start its conversation is stopped.
				if (!reply.ok) throw new RefusedBeginning(reply);
				// The watch must name what the answer named.
				const { result } = reply;
				const answered = isRecord(result) ? result.sessionId : undefined;
				const expected = typeof answered === "string" ? answered : "";
				await watch(slot, { expected, fresh, by });
				return reply;
			}).catch((error) => {
				if (error instanceof RefusedBeginning) return error.reply;
				throw error;
			});
		},
		async adopt() {
			const taking = (async () => {
				const slots = (await slotsIn(options.folder, options.key)).filter(
					(slot) => !inUse.has(slot.unit),
				);
				const names = await Promise.all(slots.map(slotHolds));
				return slots.map((slot, at) => {
					const named = names[at];
					const taken = takeUp(slot, named);
					const settled = taken.catch(() => undefined);
					takingUnit.set(slot.unit, settled);
					if (named) takingFor.set(keyed(named), settled);
					void settled.then(() => {
						takingUnit.delete(slot.unit);
						if (named) takingFor.delete(keyed(named));
					});
					return taken;
				});
			})();
			listing = taking.catch(() => undefined);
			const taken = await Promise.allSettled(await taking);
			let count = 0;
			for (const outcome of taken) {
				if (outcome.status === "rejected") options.report(outcome.reason);
				else if (outcome.value) count += 1;
			}
			return count;
		},
		close() {
			closing = true;
			for (const watching of watches) watching.close();
			watches.clear();
			for (const child of asking) child.destroy();
		},
	};
}
