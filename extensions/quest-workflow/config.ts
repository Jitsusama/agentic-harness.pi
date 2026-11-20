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
import {
	getSection,
	loadPackageConfig,
} from "../../lib/internal/config/loader.ts";
import { dataDir } from "../../lib/internal/paths.ts";

export {
	parseQuestWorkflowConfig,
	QUEST_WORKFLOW_SLUG,
	type QuestWorkflowConfig,
	summarizeQuestConfig,
} from "../../lib/core/quest/config.ts";

/**
 * The quest-workflow section as the config says now, and where this
 * machine's quests live by it: its `questsRoot`, or the data folder's.
 * A missing file or a malformed section reads as an empty one; the
 * config query verb is where provenance and any warning surface.
 */
export async function questWorkflowNow(): Promise<{
	section: QuestWorkflowConfig;
	questsRoot: string;
}> {
	const loaded = await loadPackageConfig();
	const section: QuestWorkflowConfig = loaded.ok
		? getSection(loaded.config, QUEST_WORKFLOW_SLUG, parseQuestWorkflowConfig)
				.value
		: {};
	return {
		section,
		questsRoot: resolveQuestsRoot(section, dataDir("quest-workflow")),
	};
}

/**
 * Where this machine's quests live, as the config says now, read just as
 * each session's quest workflow reads it when it starts.
 */
export async function questsRootNow(): Promise<string> {
	return (await questWorkflowNow()).questsRoot;
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
