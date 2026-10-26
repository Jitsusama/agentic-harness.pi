/**
 * Wants: what a peer is waiting on its person for, said in its presence
 * so others, and the desktop, can see it.
 *
 * A peer that has asked Joel something, is held at an approval, or has
 * ended an unattended run blocked is stopped until he answers, and
 * nothing else on the machine could tell: its presence said only that
 * it was idle. A want says what it waits on, since when, and in one
 * line what it said, so a peer does not wait on one that is itself
 * waiting, and the launcher can mark it for him. Skynet's register asks
 * the harness to say when a session is "waiting on a human" (R-5.6-1).
 *
 * A peer can want more than one thing at once (a question asked while
 * an approval is held), so each kind stands until it is settled, and
 * presence shows the one standing longest, which is the one he has
 * kept waiting most.
 *
 * The session says each want as it starts and ends, over the bus (see
 * lib/internal/session/wants.ts); this is the same want as presence
 * keeps it, in the same kinds and on the same one line.
 */

import { oneLine, type WantKind } from "../internal/session/wants.ts";

export type { WantKind };

/** What a peer can be waiting on its person for. */
export const WANT_KINDS: readonly WantKind[] = [
	"question",
	"approval",
	"blocked",
	"action",
];

/** One thing a peer is waiting on its person for. */
export interface Want {
	readonly kind: WantKind;
	/** When it began waiting, as an ISO time. */
	readonly since: string;
	/** What it asked or said, in one short line. */
	readonly said: string;
}

/**
 * Whether a want is said in presence for the person to see. A session
 * another orchestrates sends what it needs from him to its orchestrator,
 * which batches it (P9R1KI, 2026-10-26: "nothing reaches Joel except
 * through me"), so the question it ends a run on is its orchestrator's
 * and stays out of the launcher. An approval still shows, since only the
 * person can answer a gate held open in its window.
 */
export function wantsThePerson(
	kind: WantKind,
	orchestratedBy: string | undefined,
): boolean {
	return kind !== "question" || orchestratedBy === undefined;
}

/** A want read from outside, or nothing when it is not one. */
export function wantFrom(value: unknown): Want | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const one = value as Record<string, unknown>;
	if (!isWantKind(one.kind) || typeof one.said !== "string") return undefined;
	const since = typeof one.since === "string" ? Date.parse(one.since) : NaN;
	if (!Number.isFinite(since)) return undefined;
	return {
		kind: one.kind,
		since: new Date(since).toISOString(),
		said: oneLine(one.said),
	};
}

export function isWantKind(value: unknown): value is WantKind {
	return WANT_KINDS.some((kind) => kind === value);
}

/** The want standing longest, or nothing when none stands. */
export function longestStanding(wants: Iterable<Want>): Want | undefined {
	let longest: Want | undefined;
	for (const one of wants) {
		if (!longest || Date.parse(one.since) < Date.parse(longest.since)) {
			longest = one;
		}
	}
	return longest;
}
