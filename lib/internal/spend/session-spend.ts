/**
 * What a session's log says it has spent: every assistant turn's cost on
 * its branch, or, past a rollover record, what the record carried and the
 * turns after it. spend-workflow replays a session's total from this, and
 * the host carries the total of the turns a held conversation leaves on
 * disk under the same name, so the two always agree.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { carriedBy, type Entry, recordIndex } from "../session/rollover.ts";

/** The name spend-workflow's total is carried under in a rollover record. */
export const SPEND_CARRY = "cost-workflow";

/** Cost of an assistant turn, or zero for anything else. */
export function assistantCost(message: { role: string }): number {
	if (message.role === "assistant" && "usage" in message) {
		return (message as AssistantMessage).usage.cost.total;
	}
	return 0;
}

/** A message entry's cost, never below zero; zero for any other entry. */
function costOf(entry: unknown): number {
	if (typeof entry !== "object" || entry === null) return 0;
	const { type, message } = entry as Partial<Entry>;
	if (type !== "message" || typeof message !== "object" || message === null)
		return 0;
	const role = (message as { role?: unknown }).role;
	if (typeof role !== "string") return 0;
	return Math.max(0, assistantCost(message as { role: string }));
}

/**
 * The session's spend as its branch says it: the carried total and every
 * turn after the record when a rollover record carries one, otherwise
 * every turn on the branch.
 */
export function spentOnBranch(branch: readonly unknown[]): number {
	const carried = carriedBy(branch, SPEND_CARRY) as
		| { spend?: unknown }
		| undefined;
	const sum = (entries: readonly unknown[]): number =>
		entries.reduce<number>((total, entry) => total + costOf(entry), 0);
	const spend = carried?.spend;
	// A record written by hand or by an older harness may carry anything.
	if (typeof spend === "number" && Number.isFinite(spend) && spend >= 0) {
		return spend + sum(branch.slice(recordIndex(branch) + 1));
	}
	return sum(branch);
}
