/**
 * What the quest workflow keeps current as the agent works: where the
 * focused plan stands for away-workflow, the loaded quest's slice and
 * scoreboard at each turn's end, and the budget before each run.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setProgressSource } from "../../../lib/internal/away/state.ts";
import { onTurnEnd } from "../../../lib/internal/session/turn-end.ts";
import type { BudgetKeeper } from "../budget.ts";
import { refreshLoadedSlice, refreshProgress } from "../lifecycle.ts";
import type { QuestState } from "../state.ts";
import { updateScoreboard } from "./scoreboard.ts";

/** Keep the quest's progress, slice and budget current turn by turn. */
export function keepTurnsCurrent(
	pi: ExtensionAPI,
	state: QuestState,
	budgets: BudgetKeeper,
): void {
	// Where the focused plan stands, for away-workflow's nudge that keeps
	// an unattended run going. Only a plan in build is work in progress.
	setProgressSource(() => {
		refreshProgress(state);
		if (state.documentKind !== "plan" || state.documentStage !== "build")
			return undefined;
		if (!state.documentId || state.total === 0) return undefined;
		return {
			document: state.documentId,
			done: state.done,
			total: state.total,
			...(state.currentItem ? { next: state.currentItem } : {}),
		};
	});

	onTurnEnd(pi, async (_event, ctx) => {
		// Re-read the loaded quest's README so a title, status
		// or priority edited in place (not through a verb that
		// already updates state) is reflected in the status line
		// without a manual reload.
		refreshLoadedSlice(state);
		// A budget named by hand in a README is taken up a turn later.
		await budgets.keep(ctx);
		refreshProgress(state);
		updateScoreboard(state, ctx);
	});

	// The budget is asked for at start without waiting, so a slow
	// provider never holds the screen, and waited on here, so the first
	// model call draws on it. Once drawn, this returns at once.
	// A session on no quest may be judged from its first prompt, here,
	// before that prompt's model call.
	pi.on("before_agent_start", async (event, ctx) => {
		await budgets.keep(
			ctx,
			event.messageType === "user" ? { prompt: event.prompt } : {},
		);
	});
}
