/**
 * A line the person types during a run, until pi reads it.
 *
 * pi draws the line at once as a dim "Steering:" but reads it only once
 * the reply has streamed and every call in it has ended. So while it
 * waits, pi's working line says what it waits on, in plain words, and
 * calls that can move to the background hear of it (lib/jobs/steer.ts).
 * A line queued to follow the run, or one an extension sends, waits as
 * it was asked to and changes nothing here.
 *
 * Each line waits until pi reads its own words, since another message
 * may be read first: the run's own prompt, or a steer from elsewhere.
 * A line pi reads in other words, as a skill or template it expands,
 * waits until the run ends instead: too long, never too short.
 */

import { count, verb } from "../../lib/ui/count.ts";

/** A line typed during a run, and the calls it waits on. */
export interface TypedLine {
	/** The person typed `text`, a line pi holds until the turn's calls end. */
	typed(text: string): void;
	/** A call started. */
	started(toolCallId: string, toolName: string): void;
	/** A call ended, however it ended. */
	ended(toolCallId: string): void;
	/** pi read a message whose words are `text`, letting go a line typed so. */
	read(text: string | undefined): void;
	/** The run ended, so no line waits any more. */
	settled(): void;
	/** Whether a typed line waits to be read. */
	waiting(): boolean;
	/** What pi's working line says while the line waits; none once read. */
	words(): string | undefined;
}

/** Keep track of a typed line and the calls running beside it. */
export function typedLine(): TypedLine {
	const unread: string[] = [];
	const running = new Map<string, string>();
	return {
		typed(text) {
			unread.push(text);
		},
		started(toolCallId, toolName) {
			running.set(toolCallId, toolName);
		},
		ended(toolCallId) {
			running.delete(toolCallId);
		},
		read(text) {
			const at = text === undefined ? -1 : unread.indexOf(text);
			if (at >= 0) unread.splice(at, 1);
		},
		settled() {
			unread.length = 0;
		},
		waiting: () => unread.length > 0,
		words() {
			if (unread.length === 0) return undefined;
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
