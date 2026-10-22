/**
 * When an absent person is reached, and with what.
 *
 * Away mode keeps work going without the person, but some of it needs
 * them all the same: a call a gate held for their return, or a run with
 * nothing left in its reach that ends `Blocked:`. Said only in the
 * session's own transcript, either waits until they happen to look at
 * that window, and with many sessions running that can be the morning.
 * A desktop notification reaches them wherever they look, while the
 * session carries on with what does not need them.
 *
 * Each absence reaches them once for held calls, however many are held,
 * since the first says there is something to approve and the rest are
 * listed when they come back. A `Blocked:` reaches them once for each
 * thing it names, so a run that ends blocked on the same thing again is
 * not said twice. A session that stops being sent back to work says so
 * quietly, since nothing is broken; it only rests early.
 */

import type { Notice } from "../../lib/internal/notify.ts";
import { endingOf } from "./keep-going.ts";

/** What has already reached the person in this absence. */
export interface ReachMemory {
	absence?: string;
	heldSaid: boolean;
	blockedSaid: Set<string>;
	stopSaid: boolean;
}

/** A memory that has reached nobody yet. */
export function freshReach(): ReachMemory {
	return { heldSaid: false, blockedSaid: new Set(), stopSaid: false };
}

/** Longest body a notification carries; the session has the rest. */
export const MOST_SAID = 240;

function inAbsence(memory: ReachMemory, since: string): void {
	if (memory.absence === since) return;
	Object.assign(memory, freshReach(), { absence: since });
}

function clipped(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= MOST_SAID ? flat : `${flat.slice(0, MOST_SAID - 1)}…`;
}

/**
 * The notice for calls held in this absence, the first time any is.
 * Updates `memory`.
 */
export function heldNotice(
	where: string,
	since: string,
	held: number,
	memory: ReachMemory,
): Notice | undefined {
	inAbsence(memory, since);
	if (held === 0 || memory.heldSaid) return undefined;
	memory.heldSaid = true;
	return {
		title: `${where} holds a call for you`,
		body: "A gate held a call for your approval. The session carries on with the rest, and lists what was held when you are back.",
		urgency: "normal",
	};
}

/** The `Blocked:` line a run ended with, without its label. */
export function blockedLine(text: string): string | undefined {
	if (endingOf(text) !== "blocked") return undefined;
	const last = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.at(-1);
	return last
		?.replace(/^(?:[-*>]\s+)*(?:\*\*|__)?blocked:\s*/i, "")
		.replace(/(?:\*\*|__)$/, "")
		.trim();
}

/**
 * The notice for a run that rests blocked, once for each thing it is
 * blocked on. Updates `memory`.
 */
export function blockedNotice(
	where: string,
	since: string,
	lastText: string,
	memory: ReachMemory,
): Notice | undefined {
	inAbsence(memory, since);
	const line = blockedLine(lastText);
	if (line === undefined) return undefined;
	const said = clipped(line);
	if (memory.blockedSaid.has(said)) return undefined;
	memory.blockedSaid.add(said);
	return {
		title: `${where} needs you`,
		body: said || "Everything left needs you.",
		urgency: "normal",
	};
}

/**
 * The notice for a session that stopped being sent back to work, once
 * an absence. Updates `memory`.
 */
export function stopNotice(
	where: string,
	since: string,
	note: string,
	memory: ReachMemory,
): Notice | undefined {
	inAbsence(memory, since);
	if (memory.stopSaid) return undefined;
	memory.stopSaid = true;
	return { title: `${where} is resting`, body: clipped(note), urgency: "low" };
}
