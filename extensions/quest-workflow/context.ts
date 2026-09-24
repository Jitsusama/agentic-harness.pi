/**
 * The loaded-quest context, delivered without rewriting the cache.
 *
 * The model is told which quest the conversation is on, which
 * document is focused and at what stage. That used to be re-rendered
 * into the system prompt on every prompt, so a load, a focus or a
 * stage change altered the system prompt, which sits ahead of the
 * whole conversation in the provider's prefix cache: the next typed
 * message re-wrote every token of history at the cache-write price.
 * Over a month that was 169 full rewrites at a median context of
 * 310k tokens, about $450 at Opus 5.5 list, for a line of text.
 *
 * So the line is frozen into the system prompt the first time it is
 * rendered for a session, and a later change is said once, as a
 * message appended to the conversation, which is new content the
 * cache never held. The model sees the same current state either way,
 * and the latest statement names itself as the one that holds. The
 * ledger of what was frozen and what was last said is persisted so a
 * reload renders the same bytes, and a compaction, which summarises
 * earlier messages away, sets what was said back to the frozen line
 * so a state that differs from it is said again.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getLastEntry } from "../../lib/internal/state.ts";
import type { QuestState } from "./state.ts";

/** The customType of the message that carries a changed context. */
export const QUEST_CONTEXT_MESSAGE = "quest-workflow-context";

/** The session entry the ledger is persisted under. */
export const QUEST_CONTEXT_ENTRY = "quest-workflow-context-ledger";

const LABEL = "[Quest workflow context]";

/**
 * What the model has been told. `frozen` is the line in the system
 * prompt (null: no quest was loaded when it froze; absent: not frozen
 * yet); `delivered` is the state the model last heard.
 */
export interface QuestContextLedger {
	frozen?: string | null;
	delivered?: string | null;
}

/** One turn's contribution: the prompt, a message, the new ledger. */
export interface QuestContextTurn {
	systemPrompt: string;
	message?: { customType: string; content: string; display: boolean };
	ledger: QuestContextLedger;
}

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

/**
 * The system prompt and any message for this turn, given what the
 * model has been told and the context as it stands.
 */
export function questContextTurn(
	ledger: QuestContextLedger,
	current: string | null,
	systemPrompt: string,
): QuestContextTurn {
	const frozen = ledger.frozen === undefined ? current : ledger.frozen;
	const delivered = ledger.delivered === undefined ? frozen : ledger.delivered;
	const prompt =
		frozen === null ? systemPrompt : `${systemPrompt}\n\n${LABEL} ${frozen}`;
	const next = { frozen, delivered: current };
	if (current === delivered) return { systemPrompt: prompt, ledger: next };
	const now = current === null ? "No quest is loaded." : current;
	return {
		systemPrompt: prompt,
		ledger: next,
		message: {
			customType: QUEST_CONTEXT_MESSAGE,
			content: `${LABEL} Now: ${now} This supersedes the quest context given earlier.`,
			display: false,
		},
	};
}

/** The ledger this session persisted last, or a fresh one. */
export function restoredLedger(ctx: ExtensionContext): QuestContextLedger {
	return getLastEntry<QuestContextLedger>(ctx, QUEST_CONTEXT_ENTRY) ?? {};
}

/** Whether two ledgers say the same thing, so an unchanged one is not re-persisted. */
export function sameLedger(
	a: QuestContextLedger,
	b: QuestContextLedger,
): boolean {
	return a.frozen === b.frozen && a.delivered === b.delivered;
}

/** The ledger once a compaction has summarised earlier messages. */
export function afterCompaction(
	ledger: QuestContextLedger,
): QuestContextLedger {
	if (ledger.frozen === undefined) return ledger;
	return { frozen: ledger.frozen, delivered: ledger.frozen };
}
