/**
 * The quest-workflow section of the package configuration.
 *
 * The extension owns its own section schema and defaults; the
 * shared loader (lib/internal/config) owns the file envelope
 * and hands this parser its slice keyed by {@link QUEST_WORKFLOW_SLUG}.
 */

import { join } from "node:path";
import type { SectionParse } from "../../lib/internal/config/loader.js";

/** Section key for this extension in the package config file. */
export const QUEST_WORKFLOW_SLUG = "quest-workflow";

/** User-settable quest-workflow configuration. */
export interface QuestWorkflowConfig {
	/** Where the quest tree lives; defaults to the data dir. */
	questsRoot?: string;
}

/** Parse the quest-workflow section, defaulting an absent section to empty. */
export const parseQuestWorkflowConfig: SectionParse<QuestWorkflowConfig> = (
	value,
) => {
	if (value === undefined) return { ok: true, value: {} };
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, error: "quest-workflow config must be an object" };
	}
	const questsRoot = (value as Record<string, unknown>).questsRoot;
	if (questsRoot !== undefined && typeof questsRoot !== "string") {
		return { ok: false, error: "questsRoot must be a string" };
	}
	return { ok: true, value: questsRoot === undefined ? {} : { questsRoot } };
};

/**
 * Resolve the on-disk quests root: the configured questsRoot when
 * set, otherwise a `quests` directory under the extension's data dir.
 */
export function resolveQuestsRoot(
	config: QuestWorkflowConfig,
	dataDir: string,
): string {
	return config.questsRoot ?? join(dataDir, "quests");
}

/** Effective quest-workflow config with provenance for the query verb. */
export interface QuestConfigSummary {
	configPath: string;
	questsRoot: string;
	questsRootSource: "config" | "default";
}

/**
 * Summarize the effective configuration for the config query
 * verb: the file the values come from, the resolved quests root,
 * and whether that root was set in the file or fell back to the
 * built-in default.
 */
export function summarizeQuestConfig(opts: {
	config: QuestWorkflowConfig;
	configPath: string;
	dataDir: string;
}): QuestConfigSummary {
	return {
		configPath: opts.configPath,
		questsRoot: resolveQuestsRoot(opts.config, opts.dataDir),
		questsRootSource:
			opts.config.questsRoot !== undefined ? "config" : "default",
	};
}
