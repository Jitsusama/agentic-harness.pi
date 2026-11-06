/**
 * On no model: said on pi's event bus when a session is left on no
 * model, so an extension that is not the rollover workflow can act on
 * it without importing it.
 *
 * The mesh hears it and tells the session's orchestrator: on 5 November
 * six sessions rolled over onto no model and answered nothing for a
 * while, one of them for 26 minutes, with nobody told.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

/** Said on the bus when a session is left on no model. */
export const SESSION_ON_NO_MODEL = "session:no-model:v1";

/** What `SESSION_ON_NO_MODEL` carries. */
export interface NoModelEvent {
	/** When it was found: at the session's start, or before a turn. */
	readonly when: string;
	/** The model it ran on, as provider/id, when its log names one. */
	readonly model?: string;
	/** Why that model could not be set back, when it was tried. */
	readonly why?: string;
}

/** Say that this session is on no model. */
export function sayOnNoModel(bus: EventBus, event: NoModelEvent): void {
	bus.emit(SESSION_ON_NO_MODEL, event);
}

/** Hear each time this session is found on no model. Returns a disposer. */
export function onNoModel(
	bus: EventBus,
	listener: (event: NoModelEvent) => void,
): () => void {
	return bus.on(SESSION_ON_NO_MODEL, (data) => {
		if (isNoModel(data)) listener(data);
	});
}

function isNoModel(data: unknown): data is NoModelEvent {
	if (typeof data !== "object" || data === null) return false;
	const { when, model, why } = data as Record<string, unknown>;
	return (
		typeof when === "string" &&
		(model === undefined || typeof model === "string") &&
		(why === undefined || typeof why === "string")
	);
}
