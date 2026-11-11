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
 * With no note, no claim and no host holding it past the grace, as when
 * a host adopted the conversation and closed it straight after, nothing
 * can adopt the log any more, so plain pi takes it up. A host that holds
 * it on its roster but doesn't come back within the grace is waited on,
 * since it resumes the conversation as it starts, and the window says so
 * in one line rather than showing a frame that looks alive.
 *
 * A note a cutover claimed and died holding is given back first, on
 * every look, so it can be taken; one a live cutover holds is waited
 * on, as that cutover's adopt ends one way or the other.
 */

import type { HostHold } from "../../lib/internal/session/host-holds.ts";
import type { NoteState, TakeBack } from "../../lib/internal/session/move.ts";

/** How often the join looks again at where the session stands. */
export const JOIN_LOOK_MS = 250;

/**
 * How long the join waits on one state before it acts: five of the
 * cutover's looks (host/cutover/cutover.ts LOOK_EVERY_MS), so a running
 * cutover always claims a waiting note first.
 */
export const JOIN_GRACE_MS = 10_000;

/** Where the join looks, the machine's unless a test says. */
export interface JoinFacts {
	/** The host holding the session: open now, kept on a roster, or none. */
	readonly hold: () => Promise<HostHold | undefined>;
	/** Where the session's move note stands. */
	readonly noted: () => NoteState;
	/** Give back the notes a cutover died holding. */
	readonly restoreStranded: () => void;
	/** Take the move back for this join, as move.ts takeBackMove does. */
	readonly takeBack: () => TakeBack;
	/** Say one line in the window, over pi's last frame. */
	readonly say: (line: string) => void;
	readonly now: () => number;
	readonly pause: (ms: number) => Promise<void>;
}

/** What the window runs next. */
export type Joined =
	| { readonly to: "host"; readonly hold: HostHold }
	| { readonly to: "pi" };

/** What the join is waiting on, which it acts on once it lasts. */
type Waiting = "note" | "nothing" | "roster" | "cutover";

function waitingOn(hold: HostHold | undefined, noted: NoteState): Waiting {
	if (hold !== undefined) return "roster";
	if (noted === "waiting") return "note";
	if (noted === "claimed") return "cutover";
	return "nothing";
}

/**
 * Wait for the session to be open in its host, answering that host, or
 * answer plain pi once its note has waited unclaimed past the grace and
 * the join took it back, or once nothing at all has held it that long.
 */
export async function joinMove(
	facts: JoinFacts,
	graceMs: number = JOIN_GRACE_MS,
): Promise<Joined> {
	let waiting: Waiting | undefined;
	let since = facts.now();
	let said = false;
	for (;;) {
		facts.restoreStranded();
		const hold = await facts.hold();
		if (hold?.open) return { to: "host", hold };
		const now = waitingOn(hold, facts.noted());
		if (now !== waiting) {
			waiting = now;
			since = facts.now();
		}
		if (facts.now() - since >= graceMs) {
			if (now === "nothing") return { to: "pi" };
			if (now === "note" && facts.takeBack() === "taken") return { to: "pi" };
			if (now === "roster" && hold && !said) {
				facts.say(
					`Waiting for the ${hold.key} host to start; this window carries on there.`,
				);
				said = true;
			}
		}
		await facts.pause(JOIN_LOOK_MS);
	}
}
