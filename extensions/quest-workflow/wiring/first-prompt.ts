/**
 * A held session's first prompt makes its quest, and the session's end
 * for good clears one left as made (../sessions/first-prompt.ts). It
 * changes when what makes such a quest, or what ends a session for
 * good, does.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	hosted,
	isSessionStamp,
	SESSION_STAMP_EVENT,
} from "../../../lib/core/session/host.ts";
import { sproutSeedFrom } from "../../../lib/internal/quest/sessions/sprout-seed.ts";
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
	makesQuest,
	typedBefore,
} from "../sessions/first-prompt.ts";
import { readRecord } from "../sessions/records.ts";
import type { QuestState } from "../state.ts";
import { create } from "../verbs/lifecycle.ts";
import { sealLoadedQuest } from "../verbs/seal.ts";
import { currentSessionId } from "../verbs/shared.ts";

/** How long making the quest may hold the first prompt back. */
const MAKE_PATIENCE_MS = 5_000;

/** Make a held session's quest from its first prompt, and clear it if left as made. */
export function followFirstPrompt(pi: ExtensionAPI, state: QuestState): void {
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
		await forageQuest(state, session, event.text, (params) =>
			create(state, pi, ctx, params, AbortSignal.timeout(MAKE_PATIENCE_MS)),
		);
	});

	pi.events?.on(PARKING, (data: unknown) => {
		if (isParking(data)) parking = data.session;
	});
	// The park watch answers the ask in place before `emit` returns, so
	// whether its holder restarts it is read at the end, not here.
	pi.events?.on(RESTART_ASK, (data: unknown) => {
		if (isRestartAsk(data)) restart = data;
	});
	// A host says how each conversation ended; only one its person
	// closed ends for good.
	pi.events?.on(SESSION_STAMP_EVENT, (data: unknown) => {
		if (!hosted() || !isSessionStamp(data) || data.how !== "closed") return;
		if (data.session !== parking) void clear(data.session);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		// A host's endings come as stamps, above; its shutdown says none.
		if (hosted()) return;
		const session = currentSessionId(ctx, undefined);
		if (!session) return;
		const ended = endsForGood({
			reason: event.reason,
			parking: parking === session,
			restarting: restart?.session === session && restart.restarting === true,
			signalled: readRecord(session)?.endReason === "signalled",
		});
		if (ended) await clear(session);
	});

	async function clear(session: string): Promise<void> {
		try {
			await clearIfLeftAsMade(state, session, (params) =>
				sealLoadedQuest(state, "retire", params),
			);
		} catch {
			// The session is ending: a quest that couldn't be cleared stays
			// as any quest a person made, which costs a line in the lists.
		}
	}
}
