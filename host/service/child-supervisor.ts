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
 * may still run, so a conversation started again in that slot waits for
 * the last process to leave it. A slot whose unit can't be seen to go
 * stays in use, refusing a start in it, rather than start a second
 * child beside one that may still run.
 *
 * The shared roster is the supervisor's too, kept from the entry each
 * child sends: held from the child's first answer when it isn't held
 * already (an open, or one an earlier host opened but never held),
 * replaced when the conversation becomes another, and dropped only when
 * it is closed or released, so a parked or failed one is resumed later.
 * A child an earlier host left that became another while nothing
 * watched it answers under its new id, which replaces its slot's.
 *
 * A host stopping stops watching and leaves its children running, since
 * each is a unit of its own; the next host finds them by their slots and
 * watches them again, and clears a slot whose unit has gone. What the
 * stopping host had under way stops at its next step: a start fails as
 * the host's stop, and a child leaving is left to the next host.
 */
import { randomUUID } from "node:crypto";
import type { RosterEntry } from "../../lib/core/session/roster.ts";
import { isRecord } from "../../lib/internal/record.ts";
import { sessionAddress } from "../../lib/mesh/address.ts";
import { askOnce, reach } from "./child-requests.ts";
import {
	clearSlot,
	type Slot,
	slotOf,
	slotsIn,
	type Units,
	writeSlot,
} from "./child-units.ts";
import {
	type ChildEnding,
	type ChildWatch,
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
/** How often a starting child's socket is tried until it listens. */
const TRIED_EVERY_MS = 100;
/** How often a starting child's unit is asked whether it still runs. */
const ASKED_EVERY_MS = 1_000;
/** How often a leaving child's unit is asked whether it has gone. */
const LEFT_EVERY_MS = 250;
/** How much of why a child couldn't be watched goes in the journal. */
const SAID_CHARS = 300;

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

/** Supervise the children of the host keyed `key`, whose slots are in `folder`. */
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
}): ChildSupervisor {
	const { roster, routes, units } = options;
	const withinMs = options.listensWithinMs ?? LISTENS_WITHIN_MS;
	const answersWithinMs = options.answersWithinMs ?? ANSWERS_WITHIN_MS;
	const exitsWithinMs = options.exitsWithinMs ?? EXITS_WITHIN_MS;
	const watches = new Set<ChildWatch>();
	// Each conversation a child is starting for, so two asks start one.
	const starting = new Map<string, Promise<SessionIdentity>>();
	// Each slot a child is set up in, runs in or leaves, by its unit.
	const inUse = new Set<string>();
	// Each slot whose child is leaving, until its unit has gone.
	const leaving = new Map<string, Promise<void>>();
	// An adopt under way, which a resume waits out: a slot names the
	// conversation its child started with, not the one it may have become,
	// so only the child's answer says whether it runs the one asked for.
	let adopting: Promise<unknown> = Promise.resolve();
	let closing = false;

	/** Throws once the host has stopped watching, ending what it had under way. */
	function stillWatching(): void {
		if (closing) throw new StoppedWatching();
	}

	/**
	 * Try `attempt` until the child at its socket listens, the time runs
	 * out, its unit is found to have gone, asked once a second, or the
	 * host stops watching.
	 */
	async function once<T>(slot: Slot, attempt: () => Promise<T>): Promise<T> {
		const until = Date.now() + withinMs;
		let asked = Date.now();
		for (;;) {
			stillWatching();
			try {
				return await attempt();
			} catch (error) {
				if (!notListening(error)) throw error;
				if (Date.now() >= until)
					throw new Error(`${slot.unit} did not listen within ${withinMs} ms`);
			}
			if (Date.now() - asked >= ASKED_EVERY_MS) {
				asked = Date.now();
				if (await units.gone(slot.unit))
					throw new Error(`${slot.unit} ended before it listened`);
			}
			await pause(TRIED_EVERY_MS);
		}
	}

	/** Whether `unit` goes within `ms`, asked every LEFT_EVERY_MS. */
	async function goneWithin(unit: string, ms: number): Promise<boolean> {
		const until = Date.now() + ms;
		for (;;) {
			stillWatching();
			if (await units.gone(unit)) return true;
			if (Date.now() >= until) return false;
			await pause(LEFT_EVERY_MS);
		}
	}

	/**
	 * Let the child in `slot` go: stopped at once when `stopNow`, as for
	 * one whose watch failed and may still run, else given EXITS_WITHIN_MS
	 * to exit as it said it would, and its slot cleared and freed once its
	 * unit has gone, so nothing started in the slot meets the last one's
	 * files or the last one itself. A unit systemd can't be seen to stop
	 * keeps its slot in use; a host that stops watching meanwhile leaves
	 * the slot to the next host's adopt.
	 */
	function leave(slot: Slot, stopNow: boolean): Promise<void> {
		const already = leaving.get(slot.unit);
		if (already) return already;
		inUse.add(slot.unit);
		const left = (async () => {
			if (stopNow || !(await goneWithin(slot.unit, exitsWithinMs)))
				await units.stop(slot.unit);
			if (!(await goneWithin(slot.unit, exitsWithinMs))) {
				options.report(
					new Error(`${slot.unit} still runs, so its slot stays in use`),
				);
				return;
			}
			await clearSlot(slot);
			await units.forget(slot.unit);
			inUse.delete(slot.unit);
		})()
			.catch((error) => {
				if (!(error instanceof StoppedWatching)) options.report(error);
			})
			.finally(() => leaving.delete(slot.unit));
		leaving.set(slot.unit, left);
		return left;
	}

	/**
	 * Watch the child in `slot`, holding its route from its first answer,
	 * which must name `expected` when that is given. A child that names
	 * one conversation in its answer and another in its roster entry, or
	 * one another child's route holds, is refused, so no route or hold is
	 * taken from a child that disagrees with itself or with another.
	 */
	async function watch(slot: Slot, expected?: string): Promise<ChildWatch> {
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
		const held = (sessionId: string) =>
			roster.entries().some((entry) => entry.sessionId === sessionId);
		// Whether another child's route holds `sessionId`.
		const elsewhere = (sessionId: string) => {
			const route = routes.routeOf(sessionId);
			return route !== undefined && route.socket !== slot.socket;
		};
		const watching = await once(slot, () =>
			watchChild(slot.socket, answersWithinMs, {
				watched({ host, conversation, entry }) {
					const { sessionId } = conversation;
					if (expected !== undefined && sessionId !== expected)
						refused = new Error(
							`${slot.unit} runs ${sessionId}, not ${expected} as asked`,
						);
					else if (entry.sessionId !== sessionId)
						refused = new Error(
							`${slot.unit} runs ${sessionId} but holds ${entry.sessionId}`,
						);
					else if (elsewhere(sessionId))
						refused = new Error(
							`${slot.unit} runs ${sessionId}, which another child runs`,
						);
					if (refused) return;
					current = sessionId;
					routes.hold(conversation, { socket: slot.socket, identity: host });
					first = kept.then(async () => {
						if (held(sessionId)) return;
						// One that became another while nothing watched it.
						if (slot.name !== sessionId && held(slot.name))
							await roster.replace(slot.name, entry);
						else await roster.hold(entry);
					});
					// Its failure is the watch's, thrown below.
					kept = first.catch(() => undefined);
				},
				state: (conversation) => {
					if (conversation.sessionId === current) routes.update(conversation);
				},
				became(previousId, conversation, entry) {
					// A child speaks for its own conversation alone.
					if (previousId !== current) {
						options.report(
							new Error(
								`${slot.unit} said ${previousId} became another, but runs ${current}`,
							),
						);
						return;
					}
					if (elsewhere(conversation.sessionId)) {
						options.report(
							new Error(
								`${slot.unit} said ${previousId} became ${conversation.sessionId}, which another child runs`,
							),
						);
						return;
					}
					const was = routes.routeOf(previousId);
					routes.drop(previousId);
					current = conversation.sessionId;
					if (was) routes.hold(conversation, was);
					keep(() =>
						held(previousId)
							? roster.replace(previousId, entry)
							: roster.hold(entry),
					);
				},
				ended(why) {
					over = true;
					if (current) routes.drop(current);
					void leave(slot, why === "failed");
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
			}),
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
	 * gets that far is stopped, and its slot cleared, so no conversation
	 * runs where nothing watches it, unless the host stopped watching,
	 * which leaves every child running for the next host to take up.
	 */
	async function inSlot<T>(
		slot: Slot,
		session: RosterEntry | undefined,
		woken: boolean,
		work: () => Promise<T>,
	): Promise<T> {
		await leaving.get(slot.unit);
		if (inUse.has(slot.unit))
			throw new Error(`A child runs in ${slot.unit} already`);
		inUse.add(slot.unit);
		try {
			stillWatching();
			await writeSlot(slot, session, woken);
			await units.start(slot.unit);
			return await work();
		} catch (error) {
			if (closing) inUse.delete(slot.unit);
			else await leave(slot, true);
			throw error;
		}
	}

	async function started(
		entry: RosterEntry,
		woken: boolean,
	): Promise<SessionIdentity> {
		await adopting;
		const { sessionId } = entry;
		const running = routes
			.listed()
			.find((held) => held.sessionId === sessionId);
		if (running) return running;
		const slot = slotOf(options.folder, options.key, sessionId);
		return inSlot(
			slot,
			entry,
			woken,
			async () => (await watch(slot, sessionId)).conversation,
		);
	}

	/**
	 * Watch the child an earlier host left in `slot`, or clear it if gone.
	 * One that can't be watched is let go without waiting on it, so the
	 * resumes waiting on the adopt don't wait out its stop too: a resume
	 * in its slot still waits for it to leave.
	 */
	async function takeUp(slot: Slot): Promise<boolean> {
		if (await units.gone(slot.unit)) {
			await leave(slot, false);
			return false;
		}
		inUse.add(slot.unit);
		try {
			await watch(slot);
			return true;
		} catch (error) {
			if (closing) throw error;
			// A child nothing can watch runs a conversation nothing can
			// reach, such as one an earlier host never finished opening: it
			// is stopped, and its conversation waits in the roster.
			options.say?.(
				`${slot.unit}: stopped, since it could not be watched: ${quoted(error)}`,
			);
			void leave(slot, true);
			throw error;
		}
	}

	/**
	 * What a caller is told when its child gave its first request no
	 * answer in time, or none it could read: the child may have built the
	 * conversation all the same, so it is watched. One it runs is held and
	 * named, so the caller attaches to it rather than opening a second;
	 * one that can't be watched is stopped, with `reply` as its answer.
	 */
	async function unsettled(
		slot: Slot,
		request: Beginning,
		reply: ControlReply,
	): Promise<ControlReply> {
		let watching: ChildWatch;
		try {
			watching = await watch(slot);
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

	return {
		resume(entry, woken = false) {
			const { sessionId } = entry;
			const already = starting.get(sessionId);
			if (already) return already;
			const start = started(entry, woken).finally(() =>
				starting.delete(sessionId),
			);
			starting.set(sessionId, start);
			return start;
		},
		begin(request) {
			const slot = slotOf(options.folder, options.key, randomUUID());
			// The caller named this host, which checked it; the child has no
			// identity the caller could know yet.
			const { expectedHost: _checked, ...asked } = request;
			return inSlot(slot, undefined, false, async () => {
				const child = await once(slot, () => reach(slot.socket));
				try {
					stillWatching();
				} catch (error) {
					child.destroy();
					throw error;
				}
				const reply = await askOnce(
					child,
					`${JSON.stringify(asked)}\n`,
					request.id,
					options.report,
					answersWithinMs,
				);
				if (!reply.ok && reply.error.code === "child_unreachable")
					return unsettled(slot, request, reply);
				// A child that couldn't start its conversation is stopped.
				if (!reply.ok) throw new RefusedBeginning(reply);
				// The watch must name what the open's answer named.
				const { result } = reply;
				const answered = isRecord(result) ? result.sessionId : undefined;
				await watch(slot, typeof answered === "string" ? answered : "");
				return reply;
			}).catch((error) => {
				if (error instanceof RefusedBeginning) return error.reply;
				throw error;
			});
		},
		async adopt() {
			const taking = (async () => {
				const slots = await slotsIn(options.folder, options.key);
				return Promise.allSettled(
					slots
						.filter((slot) => !inUse.has(slot.unit))
						.map((slot) => takeUp(slot)),
				);
			})();
			adopting = taking.catch(() => undefined);
			const taken = await taking;
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
		},
	};
}
