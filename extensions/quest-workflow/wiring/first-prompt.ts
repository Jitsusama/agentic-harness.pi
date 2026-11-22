/**
 * A held session's first prompt makes its quest, and the session's end
 * for good clears one left as made (../sessions/first-prompt.ts). It
 * changes when what makes such a quest, or what ends a session for
 * good, does.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hosted } from "../../../lib/core/session/host.ts";
import { sproutSeedFrom } from "../../../lib/internal/quest/sessions/sprout-seed.ts";
import { noteState } from "../../../lib/internal/session/move.ts";
import {
	isParking,
	isRestartAsk,
	PARKING,
	RESTART_ASK,
	type RestartAsk,
} from "../../../lib/internal/session/park.ts";
import { pendingWords } from "../lifecycle.ts";
import {
	clearIfLeftAsMade,
	endsForGood,
	forageQuest,
	type Make,
	makesQuest,
	type Retire,
	typedBefore,
} from "../sessions/first-prompt.ts";
import { readRecord } from "../sessions/records.ts";
import { tookBySignal } from "../sessions/signal-stamp.ts";
import type { QuestState } from "../state.ts";
import { create } from "../verbs/lifecycle.ts";
import { sealLoadedQuest } from "../verbs/seal.ts";
import { currentSessionId } from "../verbs/shared.ts";

/**
 * How long the judgement of the new quest's budget may take. Only that
 * call takes a signal: the rest of making the quest is local disk work,
 * which holds the first prompt for as long as the disk does.
 */
const MAKE_PATIENCE_MS = 5_000;

/** What the first prompt's quest needs from the world, replaceable in tests. */
export interface FirstPromptDeps {
	/** Make the quest, as `quest create` does. */
	readonly make: (ctx: ExtensionContext) => Make;
	/** Retire the loaded quest, as `quest retire` does. */
	readonly retire: Retire;
	/** Whether a signal took the session away, which pi reports as a quit. */
	readonly signalled: (session: string) => boolean;
	/** Whether the session left a note to move to another holder. */
	readonly moving: (session: string) => boolean;
}

/** Make a held session's quest from its first prompt, and clear it if left as made. */
export function followFirstPrompt(
	pi: ExtensionAPI,
	state: QuestState,
	deps: FirstPromptDeps = liveDeps(pi, state),
): void {
	let tried = false;
	let parking: string | undefined;
	let restart: RestartAsk | undefined;

	pi.on("session_start", () => {
		tried = false;
		parking = undefined;
		restart = undefined;
	});

	pi.on("input", async (event, ctx) => {
		const ground = {
			env: process.env,
			hasUI: ctx.hasUI,
			questLoaded: state.questId !== null && state.questId !== undefined,
			sprouted: sproutSeedFrom(pendingWords(ctx).hints?.sprout) !== undefined,
			typedBefore: typedBefore(ctx.sessionManager.getEntries()),
			tried,
		};
		if (!makesQuest(event, ground)) return;
		tried = true;
		const session = currentSessionId(ctx, undefined);
		if (!session) return;
		try {
			await forageQuest(state, session, event.text, deps.make(ctx));
		} catch (error) {
			// The prompt goes on to the agent either way: a session with no
			// quest is what it was before this one tried, said in a line.
			if (ctx.hasUI)
				ctx.ui.notify(
					`No quest was made from this prompt: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
		}
	});

	pi.events?.on(PARKING, (data: unknown) => {
		if (isParking(data)) parking = data.session;
	});
	// The park watch answers the ask in place before `emit` returns, so
	// whether its holder restarts it is read at the end, not here.
	pi.events?.on(RESTART_ASK, (data: unknown) => {
		if (isRestartAsk(data)) restart = data;
	});

	pi.on("session_shutdown", async (event, ctx) => {
		// A host's endings can't be told apart: a close, a release to plain
		// pi and a /new all stamp "closed", and the two last carry on. A
		// quest kept costs a line in the lists; one retired under a session
		// that carries on ends that session, so a hosted one is kept.
		if (hosted()) return;
		const session = currentSessionId(ctx, undefined);
		if (!session) return;
		const ended = endsForGood({
			reason: event.reason,
			parking: parking === session,
			restarting: restart?.session === session && restart.restarting === true,
			signalled: deps.signalled(session),
			moving: deps.moving(session),
		});
		if (!ended) return;
		try {
			await clearIfLeftAsMade(
				state,
				session,
				deps.retire,
				ctx.sessionManager.getEntries(),
			);
		} catch {
			// The session is ending: a quest that couldn't be cleared stays
			// as any quest a person made, which costs a line in the lists.
		}
	});
}

/** The world as it is: the quest verbs, the signal stamp and the move notes. */
function liveDeps(pi: ExtensionAPI, state: QuestState): FirstPromptDeps {
	return {
		make: (ctx) => (params) =>
			create(state, pi, ctx, params, AbortSignal.timeout(MAKE_PATIENCE_MS)),
		retire: (params) => sealLoadedQuest(state, "retire", params),
		signalled: (session) =>
			tookBySignal(session) || readRecord(session)?.endReason === "signalled",
		moving: (session) => noteState(session) !== "none",
	};
}
