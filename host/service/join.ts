/**
 * The join: what a window's pi hands its window to as it moves into a
 * host in place (extensions/mesh-workflow/in-place.ts), deciding what
 * the window runs next.
 *
 * The pi has ended, leaving its move note, and the cutover adopts the
 * log into the host the note names once it sees that pi gone. The join
 * waits, drawing nothing, so the window keeps pi's last frame, until
 * the host has the conversation open; then the window becomes the
 * host's viewer. Should no cutover take the note up, as when none runs,
 * one gave up at its deadline, or a host refused the log and the
 * cutover gave the note back, the join takes the move back after
 * {@link JOIN_GRACE_MS} and the window runs plain pi on the log again.
 * The note's claim (lib/internal/session/move.ts) lets exactly one of
 * the two act, so the log never has two writers, and a host that kept
 * the log on its roster before it failed keeps it (the cutover's kept).
 *
 * A note a cutover claimed and died holding is given back first, on
 * every look, so it can be taken; one a live cutover holds is waited
 * on, as that cutover's adopt ends one way or the other.
 */

import type { HostHold } from "../../lib/internal/session/host-holds.ts";
import type { TakeBack } from "../../lib/internal/session/move.ts";

/** How often the join looks again at where the session stands. */
export const JOIN_LOOK_MS = 250;

/**
 * How long a note may wait unclaimed before the join takes the move
 * back: five of the cutover's looks (host/cutover/cutover.ts
 * LOOK_EVERY_MS), so a running cutover always claims it first.
 */
export const JOIN_GRACE_MS = 10_000;

/** Where the join looks, the machine's unless a test says. */
export interface JoinFacts {
	/** The host holding the session: open now, kept on a roster, or none. */
	readonly hold: () => Promise<HostHold | undefined>;
	/** Whether the session's note waits with no cutover holding it. */
	readonly noted: () => boolean;
	/** Give back the notes a cutover died holding. */
	readonly restoreStranded: () => void;
	/** Take the move back for this join, as move.ts takeBackMove does. */
	readonly takeBack: () => TakeBack;
	readonly now: () => number;
	readonly pause: (ms: number) => Promise<void>;
}

/** What the window runs next. */
export type Joined =
	| { readonly to: "host"; readonly hold: HostHold }
	| { readonly to: "pi" };

/**
 * Wait for the session to be open in its host, answering that host, or
 * take the move back once its note has waited unclaimed past the grace.
 */
export async function joinMove(
	facts: JoinFacts,
	graceMs: number = JOIN_GRACE_MS,
): Promise<Joined> {
	let unclaimedSince: number | undefined;
	for (;;) {
		facts.restoreStranded();
		const hold = await facts.hold();
		if (hold?.open) return { to: "host", hold };
		// Kept on a roster, the host resumes it as it starts again.
		if (hold === undefined && facts.noted()) {
			unclaimedSince ??= facts.now();
			const waited = facts.now() - unclaimedSince;
			if (waited >= graceMs && facts.takeBack() === "taken")
				return { to: "pi" };
		} else unclaimedSince = undefined;
		await facts.pause(JOIN_LOOK_MS);
	}
}
