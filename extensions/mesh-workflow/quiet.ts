/**
 * Quiet: other peers' news kept off the screen of a session the person
 * talks to, while the model still reads all of it.
 *
 * An orchestrator hears every peer's landings, cards and findings, a
 * line each on the screen, and the person talking to it reads his own
 * conversation between them. Joel, 11 November 2026: "I also want a
 * session that I can steer that is focused only on me and doesn't show
 * a bunch of background shit." So a session can be made quiet: a
 * delivery that only tells (fyis and findings, starting no turn) draws
 * nothing, and the footer counts what it kept off. What asks something
 * still shows: a question, a hold, a pivot, an answer to this peer, and
 * anything that starts a turn. Only the screen changes; what the model
 * is sent stays the same, and mesh_read has every message.
 *
 * The setting is the session's, kept in its log, so a reload or a
 * restart in place finds it as it was left.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../lib/internal/record.ts";
import type { Message } from "../../lib/mesh/message.ts";
import { NOTED } from "./delivery.ts";

/** The customType of the log entry that records the setting. */
export const QUIET = "mesh-quiet";

/** The footer's key for what quiet kept off the screen. */
export const QUIET_STATUS = "mesh-quiet";

/** What a delivery says of itself, as far as quiet reads it. */
export interface Folding {
	readonly messages?: readonly Pick<Message, "intent">[];
	readonly turn?: boolean;
	/**
	 * Whether it answers this peer or asks something of it, whatever became
	 * of its turn: a session its person paused is handed such a message
	 * with no turn, and quiet must still show it.
	 */
	readonly forThisPeer?: boolean;
}

/** The intents that only tell, and ask nothing of anyone. */
const TELLING: ReadonlySet<string> = new Set(["fyi", "finding"]);

/**
 * Whether a quiet session keeps a delivery off its screen: one that
 * started no turn, holds only fyis and findings, and answers nothing
 * this peer asked. A delivery with no messages is the mesh speaking for
 * itself (a hold over, another session on this quest), which the person
 * should see.
 */
export function folds(delivery: Folding | undefined): boolean {
	const messages = delivery?.messages ?? [];
	if (delivery?.turn === true || delivery?.forThisPeer === true) return false;
	if (messages.length === 0) return false;
	return messages.every((message) => TELLING.has(message.intent));
}

/**
 * How many messages a session's log shows quiet kept off its screen
 * since it last went on, so the footer says after a reload what the
 * screen still hides rather than starting again at none.
 */
export function keptOffIn(entries: readonly unknown[]): number {
	let kept = 0;
	for (let at = entries.length - 1; at >= 0; at--) {
		const entry = entries.at(at);
		if (!isRecord(entry)) continue;
		if (entry.type === "custom" && entry.customType === QUIET) {
			return isRecord(entry.data) && entry.data.on === true ? kept : 0;
		}
		if (entry.type !== "custom_message" || entry.customType !== NOTED) continue;
		const delivery = foldingOf(entry.details);
		if (folds(delivery)) kept += delivery?.messages?.length ?? 0;
	}
	return 0;
}

/** What a logged delivery's details say, as far as quiet reads them. */
function foldingOf(details: unknown): Folding | undefined {
	if (!isRecord(details) || !Array.isArray(details.messages)) return undefined;
	const messages = details.messages.filter(
		(one): one is Pick<Message, "intent"> =>
			isRecord(one) && typeof one.intent === "string",
	);
	return {
		messages,
		turn: details.turn === true,
		forThisPeer: details.forThisPeer === true,
	};
}

/** Whether the latest setting in a session's log is quiet. */
export function quietIn(entries: readonly unknown[]): boolean {
	for (let at = entries.length - 1; at >= 0; at--) {
		const entry = entries.at(at);
		if (
			isRecord(entry) &&
			entry.type === "custom" &&
			entry.customType === QUIET
		) {
			return isRecord(entry.data) && entry.data.on === true;
		}
	}
	return false;
}

/**
 * What `/mesh quiet` asks for: on, off, or the other of what it is now.
 * Anything else it was given is undefined, for the command to explain.
 */
export function quietWanted(args: string, now: boolean): boolean | undefined {
	const [verb, value, ...rest] = args.trim().split(/\s+/);
	if (verb !== "quiet" || rest.length > 0) return undefined;
	if (value === undefined) return !now;
	if (value === "on") return true;
	if (value === "off") return false;
	return undefined;
}

/** What the person is told when they turn quiet on or off. */
export function quietSaid(on: boolean): string {
	return on
		? "Mesh quiet: other sessions' fyis and findings stay off this screen from now on; questions, holds and pivots still show. /mesh quiet again shows everything."
		: "Mesh quiet off: other sessions' messages show here again.";
}

/** The footer's line while quiet: how many peer notes it kept off. */
export function quietStatus(held: number, theme: Theme): string {
	const notes = held === 1 ? "1 peer note" : `${held} peer notes`;
	return theme.fg("dim", `mesh quiet · ${notes} kept off screen`);
}
