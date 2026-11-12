/**
 * A line the person types while a run is under way.
 *
 * pi reads such a line only once the turn's reply has streamed and every
 * tool call in it has ended, so it waits on the slowest call: on 11
 * November lines waited up to 101.6 s. A call that can move to the
 * background (hand-off.ts) moves soon after the line arrives rather than
 * at the minute, so the line is read as soon as the calls that can't move
 * are done. Only the person's own lines count: a mesh message steered in
 * by an extension waits its turn as it always has.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

/** Said on the bus when the person types a line pi holds for later. */
const JOBS_STEERED = "jobs:steered:v1";

/**
 * Asked with a callback, which whoever holds an unread line answers
 * `true` into before `emit` returns.
 */
const JOBS_STEER_WAITING = "jobs:steer-waiting:v1";

/** Say the person has typed a line that waits to be read. */
export function saySteered(bus: Pick<EventBus, "emit">): void {
	bus.emit(JOBS_STEERED, undefined);
}

/** Hear each line the person types during a run. Returns a disposer. */
export function onSteered(bus: EventBus, listener: () => void): () => void {
	return bus.on(JOBS_STEERED, () => listener());
}

/** Whether a payload is a callback to answer into. */
function isAnswer(data: unknown): data is (waiting: boolean) => void {
	return typeof data === "function";
}

/** Whether a line the person typed still waits to be read, found now. */
export function steerWaiting(bus: Pick<EventBus, "emit">): boolean {
	let waiting = false;
	bus.emit(JOBS_STEER_WAITING, (answer: boolean) => {
		waiting ||= answer;
	});
	return waiting;
}

/** Answer whether a line waits, as `waiting` says. Returns a disposer. */
export function answerSteerWaiting(
	bus: EventBus,
	waiting: () => boolean,
): () => void {
	return bus.on(JOBS_STEER_WAITING, (data) => {
		if (isAnswer(data)) data(waiting());
	});
}
