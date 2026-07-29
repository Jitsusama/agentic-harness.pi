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
	/**
	 * Whether a fresh session may auto-load a quest from its
	 * working directory at session start. Defaults to true, the
	 * cd-into-a-tree-and-attach flow. Set false to keep fresh
	 * sessions idle until an explicit `quest load`; /reload
	 * restore and spawn hints still work.
	 */
	autoloadFromCwd?: boolean;
	/**
	 * How many days a closed session record is kept before being
	 * forgotten. Defaults to {@link DEFAULT_SESSION_RETENTION_DAYS}.
	 * A record still open is never forgotten whatever this says,
	 * since a tab that outlives the window is still a tab.
	 */
	sessionRetentionDays?: number;
}

/**
 * How long a closed session record is kept by default.
 *
 * Long enough to cover coming back from a week away and still find
 * what was open, with room for the weekend either side. The records
 * are small and one per session, so the cost of the window is
 * negligible next to the cost of having pruned something the user
 * still wanted.
 */
export const DEFAULT_SESSION_RETENTION_DAYS = 30;

/** Parse the quest-workflow section, defaulting an absent section to empty. */
export const parseQuestWorkflowConfig: SectionParse<QuestWorkflowConfig> = (
	value,
) => {
	if (value === undefined) return { ok: true, value: {} };
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, error: "quest-workflow config must be an object" };
	}
	const record = value as Record<string, unknown>;
	const questsRoot = record.questsRoot;
	if (questsRoot !== undefined && typeof questsRoot !== "string") {
		return { ok: false, error: "questsRoot must be a string" };
	}
	const autoloadFromCwd = record.autoloadFromCwd;
	if (autoloadFromCwd !== undefined && typeof autoloadFromCwd !== "boolean") {
		return { ok: false, error: "autoloadFromCwd must be a boolean" };
	}
	const retention = record.sessionRetentionDays;
	if (
		retention !== undefined &&
		(typeof retention !== "number" ||
			!Number.isFinite(retention) ||
			retention <= 0)
	) {
		return {
			ok: false,
			error: "sessionRetentionDays must be a positive number of days",
		};
	}
	const parsed: QuestWorkflowConfig = {};
	if (questsRoot !== undefined) parsed.questsRoot = questsRoot;
	if (autoloadFromCwd !== undefined) parsed.autoloadFromCwd = autoloadFromCwd;
	if (retention !== undefined) parsed.sessionRetentionDays = retention;
	return { ok: true, value: parsed };
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
	autoloadFromCwd: boolean;
	autoloadFromCwdSource: "config" | "default";
	sessionRetentionDays: number;
	sessionRetentionDaysSource: "config" | "default";
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
		autoloadFromCwd: opts.config.autoloadFromCwd ?? true,
		autoloadFromCwdSource:
			opts.config.autoloadFromCwd !== undefined ? "config" : "default",
		sessionRetentionDays:
			opts.config.sessionRetentionDays ?? DEFAULT_SESSION_RETENTION_DAYS,
		sessionRetentionDaysSource:
			opts.config.sessionRetentionDays !== undefined ? "config" : "default",
	};
}
