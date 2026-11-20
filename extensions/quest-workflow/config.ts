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
	resolveQuestsRoot,
	type SpawnHostSetting,
	type StartHostSetting,
} from "../../lib/core/quest/config.ts";
import { dataDir } from "../../lib/internal/paths.ts";
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
 * Where this machine's quests live, as the config says now: its
 * `questsRoot`, or the data folder's when it names none or can't be read.
 */
export async function questsRootNow(): Promise<string> {
	const loaded = await loadPackageConfig();
	const section = loaded.ok
		? getSection(loaded.config, QUEST_WORKFLOW_SLUG, parseQuestWorkflowConfig)
		: { value: {} };
	return resolveQuestsRoot(section.value, dataDir("quest-workflow"));
}

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

/**
 * The budget a session moves to when the person's own key is capped,
 * read as the cap refuses so naming one needs no reload: its name, none
 * when none is named, or why the config can't be read.
 */
export async function budgetWhenCappedSetting(): Promise<{
	name?: string;
	unreadable?: string;
}> {
	const { setting, unreadable } = await hostSetting(
		(config) => config.budgetWhenCapped,
	);
	return {
		...(setting ? { name: setting } : {}),
		...(unreadable ? { unreadable } : {}),
	};
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
