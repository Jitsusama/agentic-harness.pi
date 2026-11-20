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
 * and lets the route and the slot go when the child says it ends.
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
/** How often a starting child's socket is tried until it listens. */
const TRIED_EVERY_MS = 100;
/** How often a starting child's unit is asked whether it still runs. */
const ASKED_EVERY_MS = 1_000;

/** A request that starts a conversation, as a child takes it first. */
export type Beginning = Extract<ControlRequest, { op: "open" | "adopt" }>;

/** The host's children, as the host asks for them. */
export interface ChildSupervisor {
	/**
	 * Run a held conversation in a child of its own, settling once the
	 * child has it, or with the one already running it.
	 */
	resume(entry: RosterEntry): Promise<SessionIdentity>;
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
	/** Stop watching every child, leaving each running. */
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

/**
 * Try `attempt` until the child at its socket listens, the time runs
 * out, or its unit is found to have stopped, asked once a second.
 */
async function once<T>(
	attempt: () => Promise<T>,
	withinMs: number,
	running: () => Promise<boolean>,
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
			if (!(await running()))
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
}): ChildSupervisor {
	const { roster, routes, units } = options;
	const withinMs = options.listensWithinMs ?? LISTENS_WITHIN_MS;
	const watches = new Set<ChildWatch>();
	// Each conversation a child is starting for, so two asks start one.
	const starting = new Map<string, Promise<SessionIdentity>>();

	/** Watch the child in `slot`, holding its route from its first answer. */
	async function watch(slot: Slot): Promise<ChildWatch> {
		let current: string | undefined;
		let over = false;
		// This child's roster changes, in the order it said them.
		let kept = Promise.resolve();
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
						keep(async () => {
							if (!held(entry.sessionId)) await roster.hold(entry);
						});
					},
					state: (conversation) => routes.update(conversation),
					became(previousId, conversation, entry) {
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
						clearSlot(slot).catch(options.report);
						if (!current) return;
						const gone = current;
						if (why === "closed" || why === "released")
							keep(() => roster.drop(gone));
						options.say?.(
							`${sessionAddress(current)} (${current}): its process ended, ${why}`,
						);
						options.ended?.(current, why);
					},
				}),
			withinMs,
			() => units.active(slot.unit),
		);
		// Held before anyone is told the child has it.
		await kept;
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
	 * Start the child in `slot` and settle with what `work` makes of it;
	 * a child that never gets that far is stopped, and its slot cleared,
	 * so no conversation runs where nothing watches it.
	 */
	async function inSlot<T>(
		slot: Slot,
		session: RosterEntry | undefined,
		work: () => Promise<T>,
	): Promise<T> {
		await writeSlot(slot, session);
		try {
			await units.start(slot.unit);
			return await work();
		} catch (error) {
			await units.stop(slot.unit).catch(options.report);
			await clearSlot(slot).catch(options.report);
			throw error;
		}
	}

	function started(entry: RosterEntry): Promise<SessionIdentity> {
		const slot = slotOf(options.folder, options.key, entry.sessionId);
		return inSlot(slot, entry, async () => (await watch(slot)).conversation);
	}

	return {
		resume(entry) {
			const { sessionId } = entry;
			const running = routes
				.listed()
				.find((held) => held.sessionId === sessionId);
			if (running) return Promise.resolve(running);
			const already = starting.get(sessionId);
			if (already) return already;
			const start = started(entry).finally(() => starting.delete(sessionId));
			starting.set(sessionId, start);
			return start;
		},
		begin(request) {
			const slot = slotOf(options.folder, options.key, randomUUID());
			// The caller named this host, which checked it; the child has no
			// identity the caller could know yet.
			const { expectedHost: _checked, ...asked } = request;
			return inSlot(slot, undefined, async () => {
				const child = await once(
					() => reach(slot.socket),
					withinMs,
					() => units.active(slot.unit),
				);
				const reply = await askOnce(
					child,
					`${JSON.stringify(asked)}\n`,
					request.id,
					options.report,
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
			const slots = await slotsIn(options.folder, options.key);
			const taken = await Promise.allSettled(
				slots.map(async (slot) => {
					if (!(await units.active(slot.unit))) {
						await clearSlot(slot);
						return false;
					}
					try {
						await watch(slot);
						return true;
					} catch (error) {
						// A child nothing can watch runs a conversation nothing can
						// reach, such as one an earlier host never finished opening:
						// it is stopped, and its conversation waits in the roster.
						await units.stop(slot.unit).catch(options.report);
						await clearSlot(slot);
						throw error;
					}
				}),
			);
			let count = 0;
			for (const outcome of taken) {
				if (outcome.status === "rejected") options.report(outcome.reason);
				else if (outcome.value) count += 1;
			}
			return count;
		},
		close() {
			for (const watching of watches) watching.close();
			watches.clear();
		},
	};
}
