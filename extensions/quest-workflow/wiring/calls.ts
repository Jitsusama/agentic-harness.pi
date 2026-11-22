/**
 * What each tool call is held to and what it leaves behind: the quest
 * guards before it runs, the quest records it touched read back after,
 * and the pointers, weights and desktop lists a quest action moves.
 */

import { homedir } from "node:os";
import type {
	ExtensionAPI,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { refreshQuests } from "../../../lib/internal/quest/discovery/discovery.ts";
import { keepDoingSaid } from "../../../lib/internal/quest/sessions/doing.ts";
import type { BudgetKeeper } from "../budget.ts";
import { isFocusedDocWrite, questVerdicts } from "../enforce.ts";
import { adoptTree, applyQuestGuards } from "../guard.ts";
import {
	persist,
	refreshProgress,
	retryPendingQuest,
} from "../lifecycle.ts";
import { keepDesktopListsCurrent } from "../quest-index.ts";
import { questsTouchedBy, RecordWatch } from "../record-watch.ts";
import type { QuestState } from "../state.ts";
import { currentSessionId } from "../verbs/shared.ts";
import { keepQuestWeights } from "../weights.ts";
import { defaultWorkspaceRoot } from "../workspace.ts";
import { updateScoreboard } from "./scoreboard.ts";
import { settleOnLoadedQuest } from "./session.ts";

/** What an `agent_before_settle` handler may return, as pi 0.87 defines it. */
interface BeforeSettleResult {
	entries?: {
		type: "custom_message";
		customType: string;
		content: string;
		display: boolean;
	}[];
	continue?: boolean;
}

/** Guard each tool call, and read back the quest records it touched. */
export function watchToolCalls(
	pi: ExtensionAPI,
	state: QuestState,
	questsRoot: string,
	budgets: BudgetKeeper,
): void {
	// The record, read from disk after each call that could touch a quest
	// folder, since a command can make files without naming them.
	const watch = new RecordWatch({
		questsRoot,
		workspaceRoot: defaultWorkspaceRoot(),
	});

	pi.on(
		"tool_call",
		async (event, ctx): Promise<ToolCallEventResult | undefined> => {
			const input = event.input as Record<string, unknown>;
			const refusal = applyQuestGuards(
				state,
				await questVerdicts(state, event.toolName, input, ctx.cwd, {
					byScript: event.parentToolCallId !== undefined,
				}),
				adoptTree,
				() => `${event.toolName} ${JSON.stringify(input)}`,
			);
			if (refusal) return refusal;
			watch.before(
				event.toolCallId,
				questsTouchedBy(state, event.toolName, input, ctx.cwd, homedir()),
			);
			return undefined;
		},
	);

	// Before the run settles, continue once with whatever record breakage
	// it left. The event arrived after the pi this package builds against,
	// so it is registered through the untyped surface; an older pi never
	// fires it, and the per-call reports still reach the agent.
	const onBeforeSettle = pi.on.bind(pi) as unknown as (
		event: "agent_before_settle",
		handler: () => Promise<BeforeSettleResult | undefined>,
	) => void;
	onBeforeSettle("agent_before_settle", async () => {
		const message = watch.settle();
		if (!message) return;
		return {
			entries: [
				{
					type: "custom_message",
					customType: "quest-record",
					content: message,
					display: true,
				},
			],
			continue: true,
		};
	});

	// When the focused document gets edited, repaint the
	// scoreboard so progress numbers update. Persist the
	// loaded-quest and focused-document pointers on every
	// tool result so a /reload (or any other session restart)
	// can re-hydrate without re-reading the cwd. Mirrors the
	// pr-workflow pattern: pi sequences event handlers, so a
	// tool that mutates state in-handler has finished writing
	// by the time we read it here.
	pi.on("tool_result", async (event, ctx) => {
		if (
			isFocusedDocWrite(
				event.toolName,
				event.input as Record<string, unknown>,
				state.documentPath,
				ctx.cwd,
			)
		) {
			refreshProgress(state);
			updateScoreboard(state, ctx);
			keepDoingSaid(state, currentSessionId(ctx, undefined), ctx.ui);
		}
		// A quest the log named that a slow walk hid at the start loads now,
		// and this session settles on it as its start would have.
		if (retryPendingQuest(state, pi)) {
			refreshQuests(state.questsRoot, [state.questId]);
			settleOnLoadedQuest(state, pi, ctx);
			updateScoreboard(state, ctx);
		}
		persist(state, pi, ctx);
		// A quest action can change what a quest's work is weighted by, and
		// which quests orchestrate, and what the desktop lists.
		if (event.toolName === "quest") {
			keepQuestWeights(state.questsRoot);
			const action = (event.input as { action?: unknown }).action;
			await budgets.keep(ctx, { again: action === "budget" });
			void keepDesktopListsCurrent(state.questsRoot);
		}
		const broke = watch.after(event.toolCallId);
		if (broke) {
			return { content: [...event.content, { type: "text", text: broke }] };
		}
		return undefined;
	});
}
