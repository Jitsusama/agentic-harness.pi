/**
 * A session ends itself once its quest has ended.
 *
 * Joel, 4 November: "make sure we are closing any pi processes and/or
 * kitty windows that are no longer needed". That day 19 sessions were
 * still running with their quests concluded, some since the morning,
 * each with its window open, until their orchestrator ended them by
 * hand.
 *
 * Once a minute a session reads its loaded quest's status afresh, since
 * another session may have concluded it. When the quest is concluded or
 * retired, nothing runs or waits in the session and nothing is typed in
 * its prompt, at two looks in a row, the session shuts pi down, and the
 * window it was shown in closes with it. The second look gives whoever
 * concluded it a minute to carry on there: a turn, a message or a word
 * typed starts the count again, and loading another quest ends the
 * reason. A session with no quest loaded is never ended by this.
 *
 * A session parked before its quest was concluded can't look, so it
 * kept its marker and its holder's hold, showing as a sleeping row in
 * Agents and a dormant cell in mycelium's map, and a steer would have
 * woken sealed work. Five did so on 14 November after their quests were
 * concluded at about 12:40 (KP0L6A [be748152]). So concluding or
 * retiring a quest asks the holder of each session parked with it
 * loaded to wake it. Woken, it loads its quest again, finds it ended,
 * and ends itself two looks later, its marker and hold going with it;
 * its quest having ended, it may not park again first. A wake needs
 * nobody's word, as a message to a parked peer doesn't: a woken session
 * that finds its quest open just carries on as before.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { endConversation } from "../../lib/core/session/owner.ts";
import { sessionSlot } from "../../lib/core/session/slot.ts";
import {
	askWake,
	isParkAsk,
	parkedWithQuest,
} from "../../lib/internal/session/park.ts";
import { refreshLoadedSlice } from "./lifecycle.ts";
import type { QuestState } from "./state.ts";

/** How often a session looks at its quest. */
export const LOOK_EVERY_MS = 60_000;

/** How many looks in a row find nothing left before the session ends. */
export const ENDS_AFTER_LOOKS = 2;

/** What one look finds. */
export interface SessionLook {
	/** Whether its loaded quest is concluded or retired. */
	readonly questEnded: boolean;
	/** Whether a turn runs, a message waits or words are typed. */
	readonly busy: boolean;
}

/**
 * The count of looks: call it once a look, and it calls `end` once, at
 * the look that makes `ENDS_AFTER_LOOKS` in a row with the quest ended
 * and the session not busy. A look that can't be made counts as busy.
 */
export function endingCount(
	look: () => SessionLook | undefined,
	end: () => void,
): () => void {
	let quiet = 0;
	let ended = false;
	return () => {
		if (ended) return;
		const now = look();
		quiet = now?.questEnded && !now.busy ? quiet + 1 : 0;
		if (quiet < ENDS_AFTER_LOOKS) return;
		ended = true;
		end();
	};
}

/** What a session's quest state and context say at one look. */
export function lookAt(
	state: QuestState,
	ctx: Pick<ExtensionContext, "isIdle" | "hasPendingMessages" | "hasUI" | "ui">,
): SessionLook {
	const typed = ctx.hasUI ? ctx.ui.getEditorText().trim().length > 0 : false;
	return {
		questEnded: questHasEnded(state),
		busy: !ctx.isIdle() || ctx.hasPendingMessages() || typed,
	};
}

/**
 * The running watch, at most one per process, kept on the process so a
 * reloaded copy of this module stops the one an older copy started.
 */
const WATCH_SLOT = "agentic-harness.quest-workflow.ends-with-quest";

function watchSlot(): { timer?: ReturnType<typeof setInterval> } {
	return sessionSlot<{ timer?: ReturnType<typeof setInterval> }>(
		WATCH_SLOT,
		undefined,
		() => ({}),
	);
}

/**
 * Watch the session `ctx` belongs to, ending it once its quest has
 * ended and nothing is left in it. Starting again replaces the watch;
 * the timer never holds pi open on its own.
 */
export function watchForQuestEnd(
	state: QuestState,
	ctx: ExtensionContext,
	everyMs: number = LOOK_EVERY_MS,
): void {
	stopWatchingForQuestEnd();
	const tick = endingCount(
		() => {
			try {
				return lookAt(state, ctx);
			} catch {
				// A context gone stale can't be looked at, so it is left be.
				return undefined;
			}
		},
		() => {
			stopWatchingForQuestEnd();
			endConversation(ctx, endedBy(state));
		},
	);
	const timer = setInterval(tick, everyMs);
	timer.unref?.();
	watchSlot().timer = timer;
}

/** Who ends the session, for a host's journal: its quest, as it ended. */
export function endedBy(state: QuestState): string {
	return `quest-workflow, its quest ${state.questId ?? "unknown"} being ${state.questStatus ?? "ended"}`;
}

/** Stop the watch, as a session ends. */
export function stopWatchingForQuestEnd(): void {
	const slot = watchSlot();
	if (slot.timer) clearInterval(slot.timer);
	delete slot.timer;
}

/** What a wake for a sealed quest says, as the holder records it. */
export function wakeWhy(questId: string): string {
	return `quest-ended-${questId}`;
}

/** What the session says while its quest has ended, refusing to park. */
export const ENDS_RATHER_THAN_PARKS =
	"its quest has ended, so it ends rather than parks";

/**
 * Whether the session's loaded quest has ended, read afresh, since
 * another session may have concluded it.
 */
export function questHasEnded(state: QuestState): boolean {
	refreshLoadedSlice(state);
	const status = state.questStatus;
	return (
		Boolean(state.questId) && (status === "concluded" || status === "retired")
	);
}

/**
 * Refuse a park asked of the running session while its quest has
 * ended, so it ends rather than parks; a restart, which comes back in
 * seconds, is never refused.
 */
export function refuseParkOnceEnded(
	ask: unknown,
	running: string | undefined,
	ended: () => boolean,
): void {
	if (!isParkAsk(ask) || ask.restart || ask.session !== running) return;
	if (ended()) ask.refusals.push(ENDS_RATHER_THAN_PARKS);
}

/** What waking a sealed quest's parked sessions needs. */
export interface WakingSealed {
	/** The folder parking keeps its markers under. */
	readonly folder?: string;
	/** Ask a session's holder to wake it; answers whether it was asked. */
	readonly wake?: (session: string, why: string) => boolean;
}

/**
 * Wake every session parked with this quest loaded, so each ends
 * itself; answers what to say of it, or nothing when none was parked.
 */
export function wakeSealedQuestParks(
	questId: string,
	waking: WakingSealed = {},
): string | undefined {
	const wake =
		waking.wake ??
		((session: string, why: string) => askWake(session, why, waking.folder));
	const woken: string[] = [];
	const unwoken: string[] = [];
	for (const parked of parkedWithQuest(questId, waking.folder)) {
		const name = parked.addresses[0] ?? parked.session;
		let asked = false;
		try {
			asked = wake(parked.session, wakeWhy(questId));
		} catch {
			// Said below: its holder couldn't be asked, so it sleeps on.
		}
		(asked ? woken : unwoken).push(name);
	}
	const said: string[] = [];
	if (woken.length > 0) {
		said.push(
			`Woke ${woken.length === 1 ? "its one parked session" : `its ${woken.length} parked sessions`} (${woken.join(", ")}), so ${woken.length === 1 ? "it ends" : "each ends"} itself within about two minutes.`,
		);
	}
	if (unwoken.length > 0) {
		said.push(
			`Could not wake ${unwoken.join(", ")}, parked with it, so ${unwoken.length === 1 ? "it stays" : "they stay"} parked; close ${unwoken.length === 1 ? "it" : "them"} from the launcher.`,
		);
	}
	return said.length > 0 ? said.join(" ") : undefined;
}
