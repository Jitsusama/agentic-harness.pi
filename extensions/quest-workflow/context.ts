/**
 * The loaded-quest context: which quest the conversation is on, which
 * document is focused and at what stage. It is a standing context
 * (lib/prompt), so a load, focus or stage change is said as a message
 * rather than re-rendered into the system prompt, which would rewrite
 * the cached conversation at the next prompt.
 */

import type { StandingContextWording } from "../../lib/prompt/index.ts";
import type { QuestState } from "./state.ts";

const LABEL = "[Quest workflow context]";

/**
 * How the quest context reads. The customType is the one sessions
 * already carry, so their persisted ledgers keep reading.
 */
export const QUEST_CONTEXT: StandingContextWording = {
	customType: "quest-workflow-context",
	inPrompt: (text) => `\n\n${LABEL} ${text}`,
	changed: (text) =>
		`${LABEL} Now: ${text ?? "No quest is loaded."} This supersedes the quest context given earlier.`,
};

/** The one-line context for the loaded quest, or null for none. */
export function renderQuestContext(state: QuestState): string | null {
	if (!state.questId) return null;
	const parts = [
		`Quest ${state.questId} loaded (${state.questKind ?? "quest"}, ${state.questStatus ?? "active"}/${state.questPriority ?? "active"}).`,
	];
	if (state.questTitle) parts.push(`Title: ${state.questTitle}.`);
	if (state.documentId) {
		parts.push(
			`Focused document: ${state.documentId} (${state.documentKind}/${state.documentStage}).`,
		);
	}
	return parts.join(" ");
}
