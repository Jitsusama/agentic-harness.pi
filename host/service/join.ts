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
 *
 * An attach that fails comes back through the join rather than closing
 * the window, which looks again after a pause that doubles with each
 * failure since the window came to its host (joinAfterFailedAttach).
 *
 * A release comes back through the join too: the window's viewer leaves
 * as its host lets the conversation go, and the join waits until no host
 * holds the conversation, open or on a roster, before the window runs
 * plain pi on its log, since the host tells its viewers before it stops
 * writing (host/engine/engine.ts end).
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

/** Where a join a window opened on a hosted conversation looks. */
export type ViewFacts = Pick<JoinFacts, "hold">;

/**
 * Answer the host holding the conversation, open or only kept on its
 * roster, since attaching is what wakes one parked; or plain pi, once,
 * when no host holds it at all. It never waits, as nothing moves.
 */
export async function joinView(facts: ViewFacts): Promise<Joined> {
	const hold = await facts.hold();
	return hold === undefined ? { to: "pi" } : { to: "host", hold };
}

/**
 * How long a window whose attach failed once waits before it looks
 * again, so a host that refuses it costs a line every few seconds rather
 * than a loop as fast as attach can fail.
 */
export const ATTACH_AGAIN_MS = 2_000;

/**
 * The longest a window waits between attaches that keep failing, as for
 * a conversation parked by a start that failed, whose host refuses every
 * wake until it is closed and opened again, or a host that stays down.
 */
export const ATTACH_AGAIN_MOST_MS = 30_000;

/** How long to wait before attaching again, `failures` having failed before this one. */
function attachAgainAfter(failures: number): number {
	return Math.min(ATTACH_AGAIN_MS * 2 ** failures, ATTACH_AGAIN_MOST_MS);
}

/** Where a join after a failed attach looks. */
export type FailedAttachFacts = Pick<JoinFacts, "hold" | "say" | "pause">;

/**
 * After an attach that failed with `code`, as when its host refused it,
 * the window stays: it says so, waits longer the more `failures` came
 * before it, up to {@link ATTACH_AGAIN_MOST_MS}, and looks again as a view does,
 * attaching once more while a host holds the conversation and running
 * plain pi on its log once none does.
 */
export async function joinAfterFailedAttach(
	facts: FailedAttachFacts,
	code: string,
	failures = 0,
): Promise<Joined> {
	const wait = attachAgainAfter(failures);
	facts.say(
		`The host couldn't show this conversation (attach ended ${code}); looking again in ${wait / 1_000} s.`,
	);
	await facts.pause(wait);
	return joinView(facts);
}

/** Where a join after a release looks. */
export type ReleaseFacts = Pick<JoinFacts, "hold" | "say" | "now" | "pause">;

/**
 * Wait for the host a release came from to let the conversation go,
 * answering plain pi once no host holds it at all. One still holding it
 * past the grace is waited on, saying so once, since plain pi beside it
 * would give the log a second writer.
 */
export async function joinRelease(
	facts: ReleaseFacts,
	graceMs: number = JOIN_GRACE_MS,
): Promise<Joined> {
	const since = facts.now();
	let said = false;
	for (;;) {
		const hold = await facts.hold();
		if (hold === undefined) return { to: "pi" };
		if (!said && facts.now() - since >= graceMs) {
			facts.say(
				`Waiting for the ${hold.key} host to let the conversation go; plain pi carries on here once it has.`,
			);
			said = true;
		}
		await facts.pause(JOIN_LOOK_MS);
	}
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
