/**
 * The carries under way in this process, which the doors that would end
 * a session's process unasked check before they go: its park and
 * restart in place (the mesh's park ask), a move (moving.ts's holdsOf),
 * its host's settled and ceiling restarts (host/engine/stopping.ts),
 * and every reload, whether the follower, the agent or the person asks
 * for it (reload-workflow's follow.ts and transitions.ts, and the host
 * engine's reload, through {@link carryHoldsReload}), and a rollover's
 * switch of logs in place (rollover-workflow's rollOverNow).
 *
 * Two doors go anyway. A host restart for its heap running out only
 * names the carry it ends, since a host out of memory loses every
 * conversation; and a person's Close or /exit is theirs to press.
 *
 * A carry ends its session's run before it bundles the session's
 * trees, so the session reads as idle while it writes, and its done
 * file is written last. On 23 November a background conversation idle
 * five minutes parked part-way through a carry its node had ordered,
 * and wrote no done file (BMDYSH, 01:03). A reload is held too, since
 * it replaces the context a carry under way reads and closes through,
 * as a rollover's switch does.
 *
 * A carry that carried keeps its hold while its session closes, so no
 * door and no second carry of the session goes before the close lands;
 * its session's shutdown says it has ({@link closeLanded}), since in a
 * host, whose process outlives the conversation, the hold would turn
 * the session away if it opened there again.
 *
 * Held on `globalThis`, so a reload's fresh modules and a host's engine
 * see the carries the modules before them started; each carry holds
 * its own entry, so of two carries of one session the first to end
 * lifts only its own.
 */

import { performance } from "node:perf_hooks";
import { processGlobal } from "../process/process-global.ts";

/**
 * How long a carry holds its session's doors at most, so one that hangs
 * never keeps a dead conversation's memory for good (ISXEG8, 23
 * November). A carry takes a minute or two; a node gives an ordered one
 * a quarter hour in all, counted from about when its hold begins. One
 * past it is taken as hung, by every door and by a second carry of the
 * session alike: in a host, whose process outlives a conversation's
 * park, a hold that never lapsed for any of them would turn away every
 * later carry of the session until the host restarted, which costs more
 * than a hung carry waking to write beside a second.
 */
export const CARRY_HOLDS_MOST_MS = 15 * 60_000;

/** One carry's hold on its session, let go once the carry has ended. */
export interface CarryHold {
	readonly session: string;
	/** The machine the work goes to. */
	readonly to: string;
	/**
	 * Let the session's doors go, unless its carry carried; a second call
	 * does nothing.
	 */
	release(): void;
	/**
	 * The carry carried, so its session closes: the hold stays, through
	 * any release, until its close lands or its time is up, when it goes
	 * saying that its close never landed. Called once its time is up, it
	 * changes nothing, so its release lets it go; called once its close
	 * has landed already, as a person's Close mid-carry lands, it goes.
	 */
	carried(): void;
}

/** How a hold is timed, given in tests. */
export interface HoldTiming {
	/** A clock that never jumps: suspend and clock steps move no hold. */
	readonly now?: () => number;
	readonly mostMs?: number;
	/**
	 * Told once, if the hold lapses before the carry lets it go, or, for
	 * one `carried`, before its session's close lands.
	 */
	readonly lapsed?: (hold: CarryHold, carried: boolean) => void;
}

interface Entry {
	readonly hold: CarryHold;
	readonly since: number;
	readonly until: number;
	/**
	 * Its session's close landed: a carried hold goes, and one still under
	 * way goes as it carries, since no later close will say so.
	 */
	readonly landed: () => void;
}

/** The version changes with the shape. */
const UNDER_WAY_KEY = "agentic-harness.carry.under-way.v1";

const underWay = () =>
	processGlobal(UNDER_WAY_KEY, () => new Map<string, Set<Entry>>());

const monotonic = () => performance.now();

/**
 * Hold `session`'s doors for a carry of its work to `to`, until the
 * hold is released or {@link CARRY_HOLDS_MOST_MS} has passed.
 */
export function holdForCarry(
	session: string,
	to: string,
	timing: HoldTiming = {},
): CarryHold {
	const now = timing.now ?? monotonic;
	const mostMs = timing.mostMs ?? CARRY_HOLDS_MOST_MS;
	const all = underWay();
	let released = false;
	let closing = false;
	let closed = false;
	let timedOut = false;
	let lapse: ReturnType<typeof setTimeout> | undefined;
	const letGo = () => {
		if (released) return;
		released = true;
		clearTimeout(lapse);
		const held = all.get(session);
		held?.delete(entry);
		if (held?.size === 0) all.delete(session);
	};
	const hold: CarryHold = {
		session,
		to,
		release() {
			if (!closing) letGo();
		},
		carried() {
			if (released || timedOut) return;
			if (closed) letGo();
			else closing = true;
		},
	};
	const since = now();
	const entry: Entry = {
		hold,
		since,
		until: since + mostMs,
		landed: () => {
			closed = true;
			if (closing) letGo();
		},
	};
	const held = all.get(session) ?? new Set<Entry>();
	held.add(entry);
	all.set(session, held);
	// Says once that a carry outlived its hold, so a park that ends it
	// isn't silent, and lets a carried session's go, saying its close
	// never landed, since a second carry may now write its work again;
	// unref'd, so it never keeps a process up.
	lapse = setTimeout(() => {
		if (released) return;
		timedOut = true;
		const wasCarried = closing;
		if (wasCarried) letGo();
		try {
			timing.lapsed?.(hold, wasCarried);
		} catch {
			// Thrown from a bare timer, it would end a host and every
			// conversation in it, for a warning: the hold has lapsed either way.
		}
	}, mostMs);
	lapse.unref?.();
	return hold;
}

/**
 * `session`'s close has landed, as its shutdown says: the holds of its
 * carries that carried go, and a carry still under way keeps its own
 * until it ends, carried or not.
 */
export function closeLanded(session: string): void {
	for (const entry of [...(underWay().get(session) ?? [])]) entry.landed();
}

/**
 * Why a reload of `session` waits, while a carry of its work is under
 * way: a reload replaces the context the carry reads and closes
 * through. Undefined when nothing holds it.
 */
export function carryHoldsReload(session: string): string | undefined {
	const to = carryUnderWay(session);
	return to === undefined
		? undefined
		: `its work is being carried to ${to}, and a reload would end the carry part-way`;
}

/**
 * The machine `session`'s work is being carried to, while a carry other
 * than `except` holds it within its time; the newest, when several do.
 */
export function carryUnderWay(
	session: string,
	options: { readonly except?: CarryHold; readonly now?: number } = {},
): string | undefined {
	const now = options.now ?? monotonic();
	let newest: Entry | undefined;
	for (const entry of underWay().get(session) ?? []) {
		if (entry.hold === options.except) continue;
		if (now >= entry.until) continue;
		if (newest === undefined || entry.since >= newest.since) newest = entry;
	}
	return newest?.hold.to;
}
