/**
 * The quest-workflow section of the package configuration.
 * Fully pi-agnostic; the implementation lives in
 * agentic-harness.core (which defines its own structurally
 * identical `SectionParse` rather than depending on this
 * package's single-config-file envelope).
 */

export {
	parseQuestWorkflowConfig,
	QUEST_WORKFLOW_SLUG,
	type QuestWorkflowConfig,
	resolveQuestsRoot,
	summarizeQuestConfig,
} from "../../lib/core/quest/config.ts";
