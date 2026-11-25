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
import { isRecord } from "../record.ts";
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
	/**
	 * Where a person opens it, when it has a web page: the launcher
	 * opens a change by it, since `ref` drops the change's owner.
	 */
	readonly url?: string;
	/**
	 * The commit a merged change landed as, when its host says, as hex:
	 * the launcher tells by it whether the change has reached the
	 * machine, once a switch builds a revision that holds it.
	 */
	readonly commit?: string;
	/**
	 * The branch a merged change landed on, when its host says: a change
	 * merged into a stacked parent's branch reaches no machine until that
	 * parent lands on trunk, so only one landed on trunk is matched.
	 */
	readonly onto?: string;
	/**
	 * The areas of its repository a merged change touched, those most of
	 * its files are in first (changed-areas.ts): what the mesh says a
	 * quest works on, by the ones it led (lib/mesh/led-areas.ts).
	 * Missing where nothing touched one, and from a plan item.
	 */
	readonly areas?: readonly string[];
}

/**
 * A commit id as git writes one, whole or shortened: what a revision
 * lookup is handed, so nothing else is.
 */
const COMMIT = /^[0-9a-f]{7,64}$/;

/** Whether a payload is a landing, as this version says one. */
export function isLanding(data: unknown): data is Landing {
	if (typeof data !== "object" || data === null) return false;
	const { at, ref, what, person, url, commit, onto, areas } = data as Record<
		string,
		unknown
	>;
	return (
		typeof at === "string" &&
		typeof ref === "string" &&
		ref !== "" &&
		typeof what === "string" &&
		(person === undefined || typeof person === "string") &&
		(url === undefined || typeof url === "string") &&
		(commit === undefined ||
			(typeof commit === "string" && COMMIT.test(commit))) &&
		(onto === undefined || typeof onto === "string") &&
		(areas === undefined ||
			(Array.isArray(areas) && areas.every((area) => typeof area === "string")))
	);
}

/** Say on `bus` that `ref` landed now. */
export function sayLanded(
	bus: Pick<EventBus, "emit">,
	landed: {
		ref: string;
		what: string;
		person?: string;
		url?: string;
		commit?: string;
		onto?: string;
		areas?: readonly string[];
	},
	now: number = Date.now(),
): void {
	const person = landed.person ? oneLine(landed.person) : "";
	const url = landed.url?.trim() ?? "";
	const said = landed.commit?.trim().toLowerCase() ?? "";
	// Anything but a commit id is left out rather than sent on to a
	// revision lookup.
	const commit = COMMIT.test(said) ? said : "";
	const onto = landed.onto?.trim() ?? "";
	const landing: Landing = {
		at: new Date(now).toISOString(),
		ref: landed.ref,
		what: oneLine(landed.what),
		...(person ? { person } : {}),
		...(url ? { url } : {}),
		...(commit ? { commit } : {}),
		...(onto ? { onto } : {}),
		...(landed.areas && landed.areas.length > 0
			? { areas: [...landed.areas] }
			: {}),
	};
	try {
		bus.emit(SESSION_LANDED, landing);
	} catch {
		// A bus nobody can say on, after a reload: the landing is still in
		// the plan or the pull request it came from.
	}
}

/** Said on the bus, with its URL, when a session closes a change unmerged. */
export const SESSION_CLOSED_CHANGE = "session:change-closed:v1";

/**
 * Say on `bus` that the change at `url` was closed without merging, so
 * whatever waited on it, such as a look the person was pointed at, can
 * stop waiting.
 */
export function sayClosed(bus: Pick<EventBus, "emit">, url: string): void {
	try {
		bus.emit(SESSION_CLOSED_CHANGE, { url });
	} catch {
		// A bus nobody can say on, after a reload: a look at it waits for
		// the person to clear it.
	}
}

/** Hear every change a session closes, by its URL. Returns a disposer. */
export function onClosed(
	bus: EventBus,
	listener: (url: string) => void,
): () => void {
	return bus.on(SESSION_CLOSED_CHANGE, (data) => {
		if (typeof data !== "object" || data === null) return;
		const { url } = data as Record<string, unknown>;
		if (typeof url === "string" && url !== "") listener(url);
	});
}

/** Said on the bus, with their URLs, when a session proposes changes. */
export const SESSION_PROPOSED_CHANGES = "session:changes-proposed:v1";

/**
 * Say on `bus` that this session proposed the changes at `urls`, so the
 * mesh keeps them off the person's look list past a rollover
 * (lib/mesh/looks/own-changes.ts). A change its backend gave no URL is
 * left out; nothing is said when none is named.
 */
export function sayProposed(
	bus: Pick<EventBus, "emit"> | undefined,
	urls: readonly (string | undefined)[],
): void {
	const named = urls
		.map((url) => url?.trim() ?? "")
		.filter((url) => url !== "");
	if (bus === undefined || named.length === 0) return;
	try {
		bus.emit(SESSION_PROPOSED_CHANGES, { urls: named });
	} catch {
		// A bus nobody can say on, after a reload: the session's log still
		// holds the answer that named them, which show_person also reads.
	}
}

/** Hear every change a session proposes, by their URLs. Returns a disposer. */
export function onProposed(
	bus: EventBus,
	listener: (urls: string[]) => void,
): () => void {
	return bus.on(SESSION_PROPOSED_CHANGES, (data) => {
		if (!isRecord(data) || !Array.isArray(data.urls)) return;
		const named = data.urls.filter(
			(url): url is string => typeof url === "string" && url !== "",
		);
		if (named.length > 0) listener(named);
	});
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
