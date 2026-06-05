/**
 * The config query verb.
 *
 * Reports where quest-workflow reads its configuration and the
 * effective values, marking each as set in the file or fallen
 * back to a built-in default, so the user can see and trust what
 * the harness is doing without guessing paths.
 */

import {
	getSection,
	loadPackageConfig,
} from "../../../lib/internal/config/loader.js";
import { dataDir, packageConfigPath } from "../../../lib/internal/paths.js";
import {
	parseQuestWorkflowConfig,
	QUEST_WORKFLOW_SLUG,
	type QuestWorkflowConfig,
	summarizeQuestConfig,
} from "../config.js";
import { ok, type QuestResult } from "./shared.js";

/** Report the resolved config path and effective values. */
export async function configReport(): Promise<QuestResult> {
	const configPath = packageConfigPath();
	const loaded = await loadPackageConfig(configPath);
	const section = loaded.ok
		? getSection(loaded.config, QUEST_WORKFLOW_SLUG, parseQuestWorkflowConfig)
		: { value: {} as QuestWorkflowConfig, warning: loaded.error };
	const summary = summarizeQuestConfig({
		config: section.value,
		configPath,
		dataDir: dataDir("quest-workflow"),
	});

	const lines = [
		`Config file: ${summary.configPath}`,
		`Quests root: ${summary.questsRoot} (${summary.questsRootSource})`,
	];
	if (section.warning) lines.push(`Warning: ${section.warning}`);

	return ok(lines.join("\n"), { summary, warning: section.warning });
}
