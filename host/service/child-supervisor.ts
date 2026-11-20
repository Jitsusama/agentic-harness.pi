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
 * the last process to leave it.
 *
 * The shared roster is the supervisor's too, kept from the entry each
 * child sends: held from the child's first answer when it isn't held
 * already (an open, or one an earlier host opened but never held),
 * replaced when the conversation becomes another, and dropped only when
 * it is closed or released, so a parked or failed one is resumed later.
 *
 * A host stopping stops watching and leaves its children running, since
 * each is a unit of its own; the next host finds them by their slots and
 * watches them again, and clears a slot whose unit has gone.
 */
import { randomUUID } from "node:crypto";
import type { RosterEntry } from "../../lib/core/session/roster.ts";
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
 * stopped, and a stopped one to go before its slot is cleared anyway.
 */
export const EXITS_WITHIN_MS = 30_000;
/** How often a starting child's socket is tried until it listens. */
const TRIED_EVERY_MS = 100;
/** How often a starting child's unit is asked whether it still runs. */
const ASKED_EVERY_MS = 1_000;
/** How often a leaving child's unit is asked whether it has gone. */
const LEFT_EVERY_MS = 250;

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

/**
 * Try `attempt` until the child at its socket listens, the time runs
 * out, or its unit is found to have gone, asked once a second.
 */
async function once<T>(
	attempt: () => Promise<T>,
	withinMs: number,
	gone: () => Promise<boolean>,
): Promise<T> {
	const until = Date.now() + withinMs;
	let asked = Date.now();
	for (;;) {
		try {
			return await attempt();
		} catch (error) {
			if (!notListening(error) || Date.now() >= until) throw error;
		}
		if (Date.now() - asked >= ASKED_EVERY_MS) {
			asked = Date.now();
			if (await gone())
				throw new Error("The child's process ended before it listened");
		}
		await pause(TRIED_EVERY_MS);
	}
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
	// An adopt under way, which a resume waits out, since the child it
	// asks for may be one the adopt is about to watch.
	let adopting: Promise<unknown> = Promise.resolve();
	let closing = false;

	/** Whether `unit` goes within `ms`, asked every LEFT_EVERY_MS. */
	async function goneWithin(unit: string, ms: number): Promise<boolean> {
		const until = Date.now() + ms;
		for (;;) {
			if (await units.gone(unit)) return true;
			if (Date.now() >= until) return false;
			await pause(LEFT_EVERY_MS);
		}
	}

	/**
	 * Let the child in `slot` go: stopped at once when `stopNow`, as for
	 * one whose watch failed and may still run, else given EXITS_WITHIN_MS
	 * to exit as it said it would, and its slot cleared once its unit has
	 * gone, so nothing started in the slot meets the last one's files.
	 */
	function leave(slot: Slot, stopNow: boolean): Promise<void> {
		const already = leaving.get(slot.unit);
		if (already) return already;
		inUse.add(slot.unit);
		const left = (async () => {
			if (stopNow || !(await goneWithin(slot.unit, exitsWithinMs)))
				await units.stop(slot.unit);
			if (!(await goneWithin(slot.unit, exitsWithinMs)))
				options.report(
					new Error(`${slot.unit} still runs; its slot is cleared anyway`),
				);
			await clearSlot(slot);
		})()
			.catch(options.report)
			.finally(() => {
				leaving.delete(slot.unit);
				inUse.delete(slot.unit);
			});
		leaving.set(slot.unit, left);
		return left;
	}

	/** Watch the child in `slot`, holding its route from its first answer. */
	async function watch(slot: Slot): Promise<ChildWatch> {
		let current: string | undefined;
		let over = false;
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
		const watching = await once(
			() =>
				watchChild(slot.socket, {
					watched({ host, conversation, entry }) {
						current = conversation.sessionId;
						routes.hold(conversation, { socket: slot.socket, identity: host });
						first = kept.then(async () => {
							if (!held(entry.sessionId)) await roster.hold(entry);
						});
						// Its failure is the watch's, thrown below.
						kept = first.catch(() => undefined);
					},
					state: (conversation) => routes.update(conversation),
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
					answersWithinMs,
				),
			withinMs,
			() => units.gone(slot.unit),
		);
		try {
			if (closing) throw new StoppedWatching();
			// Held before anyone is told the child has it.
			await first;
			await kept;
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
			async () => (await watch(slot)).conversation,
		);
	}

	/** Watch the child an earlier host left in `slot`, or clear it if gone. */
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
				`${slot.unit}: stopped, since it could not be watched: ${String(error)}`,
			);
			await leave(slot, true);
			throw error;
		}
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
				const child = await once(
					() => reach(slot.socket),
					withinMs,
					() => units.gone(slot.unit),
				);
				const reply = await askOnce(
					child,
					`${JSON.stringify(asked)}\n`,
					request.id,
					options.report,
					answersWithinMs,
				);
				// A child that couldn't start its conversation is stopped.
				if (!reply.ok) throw new RefusedBeginning(reply);
				await watch(slot);
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
