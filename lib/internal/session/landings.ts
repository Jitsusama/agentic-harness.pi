/**
 * What a session has landed, said on the bus and kept in its presence.
 *
 * On 2026-10-31 the mesh carried 3,815 messages, 2,795 of them fyis,
 * and at least 781 fyis named a landing, a round or a check passing:
 * status that a plan or a pull request already held, sent up to an
 * orchestrator by hand. The society model (RSCH-20261015-ZYJ3Z3) says
 * status belongs in the work, as marks others read, not in messages.
 * So what a session lands (a change merged, a plan item ticked) is said
 * here as it lands, the mesh keeps the newest few in the session's
 * presence for an orchestrator or the launcher to read, and an fyi to
 * an orchestrator that only names one of them reaches it as a glance.
 *
 * A landing is one of a few short lines: when, what landed by
 * reference (`agentic-harness.pi#920`, `PLAN-20261030-QMUYBH#14`), what
 * it is in a line, and what it means to the session's person, when
 * somebody says. mycelium carries the field whole and names it in its
 * own sessions answer, so it says nothing of pi.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { oneLine } from "./wants.ts";

/** Said on the bus when something lands. */
export const SESSION_LANDED = "session:landed:v1";

/** Said on the bus, with the ref, when something said landed is taken back. */
export const SESSION_UNLANDED = "session:unlanded:v1";

/** How many landings a presence keeps, newest first. */
export const MOST_LANDINGS = 5;

/** How long a landing stays in a presence. */
export const LANDINGS_FOR_MS = 24 * 60 * 60 * 1000;

/** Something a session landed. */
export interface Landing {
	/** When it landed, as an ISO time. */
	readonly at: string;
	/** What landed, by reference: a change as `repo#number`, a plan item as `DOC#n`. */
	readonly ref: string;
	/** What it is, in one plain line. */
	readonly what: string;
	/** What it means to the session's person, in one line, when said. */
	readonly person?: string;
}

/** Whether a payload is a landing, as this version says one. */
export function isLanding(data: unknown): data is Landing {
	if (typeof data !== "object" || data === null) return false;
	const { at, ref, what, person } = data as Record<string, unknown>;
	return (
		typeof at === "string" &&
		typeof ref === "string" &&
		ref !== "" &&
		typeof what === "string" &&
		(person === undefined || typeof person === "string")
	);
}

/** Say on `bus` that `ref` landed now. */
export function sayLanded(
	bus: Pick<EventBus, "emit">,
	landed: { ref: string; what: string; person?: string },
	now: number = Date.now(),
): void {
	const landing: Landing = {
		at: new Date(now).toISOString(),
		ref: landed.ref,
		what: oneLine(landed.what),
		...(landed.person ? { person: oneLine(landed.person) } : {}),
	};
	try {
		bus.emit(SESSION_LANDED, landing);
	} catch {
		// A bus nobody can say on, after a reload: the landing is still in
		// the plan or the pull request it came from.
	}
}

/** Say on `bus` that what landed as `ref` is taken back: a plan item unticked. */
export function sayUnlanded(bus: Pick<EventBus, "emit">, ref: string): void {
	try {
		bus.emit(SESSION_UNLANDED, { ref });
	} catch {
		// A bus nobody can say on, after a reload: the landing lapses in a day.
	}
}

/** Hear every landing taken back, by its ref. Returns a disposer. */
export function onUnlanded(
	bus: EventBus,
	listener: (ref: string) => void,
): () => void {
	return bus.on(SESSION_UNLANDED, (data) => {
		if (typeof data !== "object" || data === null) return;
		const { ref } = data as Record<string, unknown>;
		if (typeof ref === "string" && ref !== "") listener(ref);
	});
}

/** Hear every landing. Returns a disposer. */
export function onLanded(
	bus: EventBus,
	listener: (landing: Landing) => void,
): () => void {
	return bus.on(SESSION_LANDED, (data) => {
		if (isLanding(data)) listener(data);
	});
}

/** The landings still standing at `now`: within the day, newest first, at most five. */
export function standing(landings: readonly Landing[], now: number): Landing[] {
	return landings
		.filter((one) => now - Date.parse(one.at) < LANDINGS_FOR_MS)
		.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
		.slice(0, MOST_LANDINGS);
}

/** `landings` with `landing` added, in place of any earlier one of its ref. */
export function withLanding(
	landings: readonly Landing[],
	landing: Landing,
	now: number,
): Landing[] {
	return standing(
		[landing, ...landings.filter((one) => one.ref !== landing.ref)],
		now,
	);
}

/** `landings` without the one of `ref`. */
export function withoutLanding(
	landings: readonly Landing[],
	ref: string,
): Landing[] {
	return landings.filter((one) => one.ref !== ref);
}

/**
 * Whether `text` names one of `landings`: a change by its number, as
 * `#920` or `PR 920`, or a plan item by its document's id.
 */
export function namesLanding(
	text: string,
	landings: readonly Landing[],
): boolean {
	return landings.some((landing) => {
		const hash = landing.ref.lastIndexOf("#");
		if (hash < 0) return text.includes(landing.ref);
		const before = landing.ref.slice(0, hash);
		const number = landing.ref.slice(hash + 1);
		if (/^[A-Z]+-\d{8}-[A-Z0-9]+$/.test(before)) return text.includes(before);
		if (!/^\d+$/.test(number)) return text.includes(landing.ref);
		return new RegExp(`(?:#|\\bPR )${number}\\b`).test(text);
	});
}
