/**
 * A line the person types during a run, until pi reads it.
 *
 * pi draws the line at once as a dim "Steering:" but reads it only once
 * the reply has streamed and every call in it has ended. So while it
 * waits, pi's working line says what it waits on, in plain words, and
 * calls that can move to the background hear of it (lib/jobs/steer.ts).
 * A line queued to follow the run, or one an extension sends, waits as
 * it was asked to and changes nothing here.
 */

import { count, verb } from "../../lib/ui/count.ts";

/** A line typed during a run, and the calls it waits on. */
export interface TypedLine {
	/** The person typed a line pi holds until the turn's calls end. */
	typed(): void;
	/** A call started. */
	started(toolCallId: string, toolName: string): void;
	/** A call ended, however it ended. */
	ended(toolCallId: string): void;
	/** pi read the line, or the run ended and nothing waits any more. */
	read(): void;
	/** Whether a typed line waits to be read. */
	waiting(): boolean;
	/** What pi's working line says while the line waits; none once read. */
	words(): string | undefined;
}

/** Keep track of a typed line and the calls running beside it. */
export function typedLine(): TypedLine {
	let waiting = false;
	const running = new Map<string, string>();
	return {
		typed() {
			waiting = true;
		},
		started(toolCallId, toolName) {
			running.set(toolCallId, toolName);
		},
		ended(toolCallId) {
			running.delete(toolCallId);
		},
		read() {
			waiting = false;
		},
		waiting: () => waiting,
		words() {
			if (!waiting) return undefined;
			return `Your message is read once ${waitedOn([...running.values()])}`;
		},
	};
}

/** What a line waits on: the calls running, or the reply when none are. */
function waitedOn(names: readonly string[]): string {
	const [only] = names;
	if (only === undefined) return "this reply ends";
	if (names.length === 1) return `${only} ends`;
	return `${count(names.length, "call")} ${verb(names.length, "ends", "end")}`;
}
