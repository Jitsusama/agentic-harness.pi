/**
 * What a session did in its repositories and quests, said on the bus and
 * kept in its presence.
 *
 * Joel asked on 15 November to see activity as actions in repositories
 * and quests: a commit, a push, a change proposed or merged, a plan
 * moving a stage. The tool that does each says it here as it does it,
 * the mesh keeps the newest in the session's presence, and mycelium
 * carries them as its `event` kind (its PROTOCOL.md, A Session), keyed by
 * the session and the time. So an event names where it happened, by a
 * repository's key or a quest's id, and says nothing of pi.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

/** Said on the bus when a session does something worth seeing. */
export const SESSION_DID = "session:did:v1";

/** How many events a presence keeps, newest first, as mycelium reads. */
export const MOST_EVENTS = 20;

/** How long an event stays in a presence; mycelium keeps it after. */
export const EVENTS_FOR_MS = 60 * 60 * 1000;

/** The longest title mycelium keeps, in characters. */
export const TITLE_MOST = 120;

/** The kinds of thing an event says a session did. */
export const EVENT_KINDS = ["commit", "push", "pr", "merge", "stage"] as const;

/** What an event says a session did. */
export type EventKind = (typeof EVENT_KINDS)[number];

/** One thing a session did, and where. */
export interface SessionEvent {
	/** When, as an ISO time. */
	readonly at: string;
	readonly kind: EventKind;
	/** Where: a repository's key (`github:owner/name`) or a quest's id. */
	readonly where: string;
	/** What it was, in one line of at most {@link TITLE_MOST} characters. */
	readonly title: string;
}

/** Whether a value is one of the kinds an event says. */
function isEventKind(value: unknown): value is EventKind {
	return EVENT_KINDS.some((kind) => kind === value);
}

/** Whether a payload is an event, as this version says one. */
export function isSessionEvent(data: unknown): data is SessionEvent {
	if (typeof data !== "object" || data === null) return false;
	const { at, kind, where, title } = data as Record<string, unknown>;
	return (
		typeof at === "string" &&
		!Number.isNaN(Date.parse(at)) &&
		isEventKind(kind) &&
		typeof where === "string" &&
		where !== "" &&
		typeof title === "string"
	);
}

/** `text` as one line, cut to what mycelium keeps. */
function titleLine(text: string): string {
	return [...text.replace(/\s+/g, " ").trim()].slice(0, TITLE_MOST).join("");
}

/** Say on `bus` that the session did this now; nothing when `where` is empty. */
export function sayDid(
	bus: Pick<EventBus, "emit"> | undefined,
	did: { kind: EventKind; where: string; title: string },
	now: number = Date.now(),
): void {
	const where = did.where.trim();
	if (bus === undefined || where === "") return;
	const event: SessionEvent = {
		at: new Date(now).toISOString(),
		kind: did.kind,
		where,
		title: titleLine(did.title),
	};
	try {
		bus.emit(SESSION_DID, event);
	} catch {
		// A bus nobody can say on, after a reload: what was done is still in
		// the repository, the change or the plan it happened in.
	}
}

/** Hear every event a session says. Returns a disposer. */
export function onDid(
	bus: EventBus,
	listener: (event: SessionEvent) => void,
): () => void {
	return bus.on(SESSION_DID, (data) => {
		if (isSessionEvent(data)) listener(data);
	});
}

/** The events still standing at `now`: within the hour, newest first, at most twenty. */
export function recentEvents(
	events: readonly SessionEvent[],
	now: number,
): SessionEvent[] {
	return events
		.filter((one) => now - Date.parse(one.at) < EVENTS_FOR_MS)
		.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
		.slice(0, MOST_EVENTS);
}

/** What each quest action that moves a document's stage says it did. */
const STAGE_WORDS: Readonly<Record<string, string>> = {
	think: "is being thought through",
	draft: "was drafted",
	build: "is being built",
	conclude: "was concluded",
	retire: "was retired",
};

/**
 * The title of the event a quest action makes, as `PLAN-1 was drafted`,
 * or nothing for an action that moves no stage.
 */
export function stageTitle(
	action: string,
	document: string | undefined,
): string | undefined {
	const words = STAGE_WORDS[action];
	return words === undefined
		? undefined
		: `${document || "A document"} ${words}`;
}

/** The well-formed events in a presence's field, or none. */
export function eventsFrom(value: unknown): SessionEvent[] {
	return Array.isArray(value) ? value.filter(isSessionEvent) : [];
}
