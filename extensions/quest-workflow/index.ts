/**
 * Quest Workflow Extension
 *
 * One hierarchy of work: campaigns (quests),
 * subquests under them, and free-standing sidequests, with
 * plan, research, brief and report documents nested
 * underneath. Subsumes the plan-workflow stage machine and
 * the asks/sidequests/issues substrate that lived under
 * `~/src/localhost/documents/projects/`.
 *
 * The extension is the only one with the `quest` tool; the
 * skill teaches the methodology, the convention skill
 * teaches the README format, and this extension keeps the
 * state and the discipline. One tool, action verbs, no
 * slash commands for the primary surface.
 *
 * This file registers and wires; what each piece answers lives in
 * `wiring/`, one file per reason to change.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BUDGET_ENTRY } from "../../lib/budget/record.ts";
import { registerBuiltinTreeProviders } from "../../lib/core/tree/register.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { registerBuiltinUrlFetchers } from "../../lib/internal/quest/creation/url-fetchers.ts";
import { offerShellEnvironment } from "../../lib/internal/shell/environment.ts";
import { registerBuiltinHandleTypes } from "../../lib/people/register.ts";
import { registerBuiltinPersonResolvers } from "../../lib/people/resolve.ts";
import { registerStandingContext } from "../../lib/prompt/standing.ts";
import { registerBuiltinRefTypes } from "../../lib/refs/register.ts";
import { registerBuiltinTerminalDrivers } from "../../lib/terminal/register.ts";
import { registerBatchingTrial } from "./batching-trial.ts";
import { budgetEntryView, keepQuestBudget } from "./budget.ts";
import { answerTreeClaims, forgetSweptTrees } from "./claims.ts";
import { budgetWhenCappedSetting, questWorkflowNow } from "./config.ts";
import { QUEST_CONTEXT, renderQuestContext } from "./context.ts";
import { settleLaunchedSpawn } from "./launched-spawn.ts";
import { keepOrchestrationClaimed } from "./orchestration-claim.ts";
import { questCommandEnvironment } from "./scratch.ts";
import { STANDING_RULES, standingRules } from "./standing-rules.ts";
import { createQuestState } from "./state.ts";
import { watchToolCalls } from "./wiring/calls.ts";
import { registerQuestCommands } from "./wiring/commands.ts";
import { registerOnTop } from "./wiring/on-top.ts";
import { followSessionLife } from "./wiring/session.ts";
import { registerQuestTool } from "./wiring/tool.ts";
import { keepTurnsCurrent } from "./wiring/turns.ts";
import { defaultWorkspaceRoot } from "./workspace.ts";

export default async function questWorkflow(pi: ExtensionAPI) {
	// First, before pi draws: a plain spawn the launcher started goes to
	// the host spawnHost names, whatever code its spawner ran, and this pi
	// ends; one that stays says why once it is up.
	const stayedBecause = await settleLaunchedSpawn();
	declareGuards(
		GUARDS.questRecord,
		GUARDS.questOwnedFields,
		GUARDS.questDocumentRead,
		GUARDS.questTemp,
		GUARDS.questPlanStage,
		GUARDS.questUntrackedTree,
		GUARDS.questHomeless,
	);
	// Seed the pluggable registries with their built-in
	// types on activate. Idempotent: re-registers cleanly.
	registerBuiltinRefTypes();
	registerBuiltinHandleTypes();
	registerBuiltinPersonResolvers();
	registerBuiltinUrlFetchers();
	registerBuiltinTerminalDrivers();
	registerBuiltinTreeProviders();

	// The quests root from the package config file, as the sweep outside
	// the hosts reads it too (scripts/pi-sweep.ts).
	const { section, questsRoot } = await questWorkflowNow();
	const state = createQuestState({
		questsRoot,
		autoloadFromCwd: section.autoloadFromCwd,
		sessionRetentionDays: section.sessionRetentionDays,
	});

	// So the working layer does not reclaim a tree a quest is holding,
	// and a quest stops listing one an unattended sweep took.
	answerTreeClaims(pi, questsRoot);
	forgetSweptTrees(pi, questsRoot);

	// The model calls draw on the budget the loaded quest names, and what
	// a name means is asked of the budget providers registered here.
	// A session on the person's own key that the cap refuses moves to the
	// budget the config names for it (lib/budget/capped.ts).
	const budgets = keepQuestBudget(pi, state, {
		whenCapped: budgetWhenCappedSetting,
	});
	// A budget the quest named but the session couldn't draw on is a line
	// in the session; any other budget entry is the log's alone.
	pi.registerEntryRenderer?.(BUDGET_ENTRY, (entry, _options, theme) =>
		budgetEntryView(entry.data, theme),
	);

	// The agent's commands name the loaded quest, so the machine can
	// share itself by quest, and their temporary files go where that
	// quest reaps them. Asked as each command starts, so loading another
	// quest moves both.
	offerShellEnvironment("quest-workflow", () =>
		questCommandEnvironment(defaultWorkspaceRoot(), state.questId),
	);

	registerQuestTool(pi, state);
	registerQuestCommands(pi, state);
	watchToolCalls(pi, state, questsRoot, budgets);
	keepTurnsCurrent(pi, state, budgets);
	followSessionLife(pi, state, budgets, stayedBecause);

	// The node routes to an orchestrator by the quests its session claims,
	// so a session heading one tells it what it orchestrates.
	keepOrchestrationClaimed(pi, state);

	// Tell the model which quest the conversation is on, which document
	// is focused and at what stage, without re-deriving it from disk on
	// every step. A standing context: frozen into the system prompt, with
	// a later change said as a message, so a quest action never rewrites
	// the cached conversation.
	registerStandingContext(pi, QUEST_CONTEXT, () => renderQuestContext(state));

	// The rules the orchestrator above this quest sets for every quest
	// below it, so a session starts with them rather than reading that
	// quest's whole README.
	const rulesFor = standingRules(() => state.questsRoot);
	registerStandingContext(pi, STANDING_RULES, () => rulesFor(state.questId));

	// What Joel put on top, said to every session as it next works.
	registerOnTop(pi);

	// Half of WCJQSG's builders try sending independent looks together.
	registerBatchingTrial(
		pi,
		() => state.questsRoot,
		() => state.questId,
	);
}
