/**
 * The quest-workflow section of the package configuration.
 * Fully pi-agnostic; the implementation lives in
 * agentic-harness.core (which defines its own structurally
 * identical `SectionParse` rather than depending on this
 * package's single-config-file envelope).
 */

export {
	DEFAULT_SESSION_RETENTION_DAYS,
	parseQuestWorkflowConfig,
	QUEST_WORKFLOW_SLUG,
	type QuestConfigSummary,
	type QuestWorkflowConfig,
	resolveQuestsRoot,
	type SectionParse,
	summarizeQuestConfig,
} from "@jitsusama/agentic-harness.core/quest/config";
