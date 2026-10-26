/**
 * Concluded: said on pi's event bus when a quest or one of its
 * documents is concluded or retired, so an extension that is not the
 * quest workflow can act on it without importing it.
 *
 * The mesh hears it and tells the session's orchestrator, with no model
 * involved: an orchestrator used to learn a plan was done only when the
 * session that did it remembered to say so.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

/** Said on the bus when a quest or a document ends. */
export const QUEST_CONCLUDED = "quest:concluded:v1";

/** What `QUEST_CONCLUDED` carries. */
export interface ConcludedEvent {
	/** Whether it was concluded or retired. */
	readonly how: "concluded" | "retired";
	/** The quest or document ids the call named, or what it acted on. */
	readonly ids: readonly string[];
	/** What the quest tool answered, which names what ended and how. */
	readonly said: string;
}

/** Say that something ended. */
export function sayConcluded(bus: EventBus, event: ConcludedEvent): void {
	bus.emit(QUEST_CONCLUDED, event);
}

/** Hear each quest or document end. Returns a disposer. */
export function onConcluded(
	bus: EventBus,
	listener: (event: ConcludedEvent) => void,
): () => void {
	return bus.on(QUEST_CONCLUDED, (data) => {
		if (isConcluded(data)) listener(data);
	});
}

function isConcluded(data: unknown): data is ConcludedEvent {
	if (typeof data !== "object" || data === null) return false;
	const { how, ids, said } = data as Record<string, unknown>;
	return (
		(how === "concluded" || how === "retired") &&
		Array.isArray(ids) &&
		ids.every((id) => typeof id === "string") &&
		typeof said === "string"
	);
}
