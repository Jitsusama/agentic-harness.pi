/**
 * The harness's own turns wait a moment for a reload that is waiting.
 *
 * A reload runs between runs, once the session has been still for a
 * second (transitions.ts's `untilStill`). In a busy session that second
 * never came: on 29 October a reload asked at 07:47:37Z landed at
 * 08:22:25Z, because each time a run ended, a background job's result,
 * a mesh message or the away nudge started the next one at once. Each
 * of those is the harness's own, and each is said again by the runtime
 * a reload starts, so holding it a moment loses nothing.
 *
 * So a delivery that would start a turn asks first. It is held while a
 * reload is asked for and not yet under way, from the first moment it
 * was otherwise free to go, and for at most {@link HOLD_FOR_RELOAD_MS}
 * of that moment: a reload that does not come then holds nothing back.
 * A pause in asking, as a run that started some other way makes, ends
 * the moment, so a long run never spends the hold before it ends.
 *
 * A message that resumes a run cut short, as a compaction's does, is
 * not one to hold: nothing would say it again after the reload.
 *
 * A delivery the new runtime would say without a turn, as mesh's
 * catch-up does, is said now instead, without its turn, and the turn is
 * owed to the reload's landing ({@link oweTurnToReload}). If no reload
 * takes it within the hold, the delivery starts the turn itself
 * ({@link takeOwedTurn}).
 */

import { reloadSlot } from "./slot.ts";

/** How long a moment a delivery is held for a waiting reload. */
export const HOLD_FOR_RELOAD_MS = 10_000;

/**
 * How long a delivery may go unasked before its next ask is a new
 * moment: a few of the job outbox's one-second looks.
 */
export const MOMENT_GAP_MS = 3_000;

/** Asked when a delivery is otherwise free to go: whether it waits. */
export type ReloadHold = () => boolean;

/** A hold for one delivery, with a clock of its own. */
export function createReloadHold(now: () => number = Date.now): ReloadHold {
	let since: number | undefined;
	let asked: number | undefined;
	return () => {
		const at = now();
		const slot = reloadSlot();
		const gap = asked === undefined || at - asked > MOMENT_GAP_MS;
		asked = at;
		if (slot.request === undefined || slot.reloading === true) {
			since = undefined;
			return false;
		}
		if (since === undefined || gap) since = at;
		return at - since < HOLD_FOR_RELOAD_MS;
	};
}

/** A turn was put off for the waiting reload: its landing starts one. */
export function oweTurnToReload(): void {
	reloadSlot().turnOwed = true;
}

/**
 * Whether a turn is still owed, taking it: the landing asks, and so does
 * the delivery that put it off, once its hold has passed.
 */
export function takeOwedTurn(): boolean {
	const slot = reloadSlot();
	if (slot.turnOwed !== true) return false;
	slot.turnOwed = undefined;
	return true;
}
