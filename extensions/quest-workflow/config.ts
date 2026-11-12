/**
 * The quest-workflow section of the package configuration.
 * Fully pi-agnostic; the implementation lives in
 * agentic-harness.core (which defines its own structurally
 * identical `SectionParse` rather than depending on this
 * package's single-config-file envelope).
 */

import {
	parseQuestWorkflowConfig,
	QUEST_WORKFLOW_SLUG,
	type SpawnHostSetting,
} from "../../lib/core/quest/config.ts";
import {
	getSection,
	loadPackageConfig,
} from "../../lib/internal/config/loader.ts";

export {
	parseQuestWorkflowConfig,
	QUEST_WORKFLOW_SLUG,
	type QuestWorkflowConfig,
	resolveQuestsRoot,
	summarizeQuestConfig,
} from "../../lib/core/quest/config.ts";

/**
 * The spawnHost setting as the config says it now, read at each spawn so
 * turning it on or off needs no reload, or why it can't be read.
 */
export async function spawnHostSetting(): Promise<{
	setting?: SpawnHostSetting;
	unreadable?: string;
}> {
	const loaded = await loadPackageConfig();
	if (!loaded.ok) return { unreadable: loaded.error };
	const section = getSection(
		loaded.config,
		QUEST_WORKFLOW_SLUG,
		parseQuestWorkflowConfig,
	);
	if (section.warning) return { unreadable: section.warning };
	return section.value.spawnHost ? { setting: section.value.spawnHost } : {};
}
