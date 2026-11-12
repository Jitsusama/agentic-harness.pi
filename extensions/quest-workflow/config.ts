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
	type QuestWorkflowConfig,
	type SpawnHostSetting,
	type StartHostSetting,
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
export function spawnHostSetting(): Promise<{
	setting?: SpawnHostSetting;
	unreadable?: string;
}> {
	return hostSetting((config) => config.spawnHost);
}

/**
 * The startHost setting as the config says it now, read at each of the
 * launcher's starts, or why it can't be read.
 */
export function startHostSetting(): Promise<{
	setting?: StartHostSetting;
	unreadable?: string;
}> {
	return hostSetting((config) => config.startHost);
}

/** One of the section's host settings, read now, or why it can't be read. */
async function hostSetting<T>(
	pick: (config: QuestWorkflowConfig) => T | undefined,
): Promise<{ setting?: T; unreadable?: string }> {
	const loaded = await loadPackageConfig();
	if (!loaded.ok) return { unreadable: loaded.error };
	const section = getSection(
		loaded.config,
		QUEST_WORKFLOW_SLUG,
		parseQuestWorkflowConfig,
	);
	if (section.warning) return { unreadable: section.warning };
	const setting = pick(section.value);
	return setting ? { setting } : {};
}
