/**
 * The config query verb.
 *
 * Reports where quest-workflow reads its configuration and the
 * effective values, marking each as set in the file or fallen
 * back to a built-in default, so the user can see and trust what
 * the harness is doing without guessing paths. Given a `ref`, it sets a
 * quest's own setting instead: how its sessions hear the mesh.
 */

import {
	getSection,
	loadPackageConfig,
} from "../../../lib/internal/config/loader.ts";
import { dataDir, packageConfigPath } from "../../../lib/internal/paths.ts";
import { appendJourneyByPath } from "../../../lib/internal/quest/append-journey.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/mutate.ts";
import type { QuestFrontMatter } from "../../../lib/quest/types.ts";
import {
	parseQuestWorkflowConfig,
	QUEST_WORKFLOW_SLUG,
	type QuestWorkflowConfig,
	summarizeQuestConfig,
} from "../config.ts";
import type { QuestState } from "../state.ts";
import { addressOf } from "./address.ts";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

/** How the report says a quest's hearing is set, and the refusal too. */
const HEARS_USAGE =
	"config with id and ref hears=addressed or hears=all sets how a quest's sessions hear the mesh: addressed hears in full only what is put to them, all as every peer does.";

/**
 * Report the config, or with a `ref` set a quest's own setting: how
 * its sessions hear the mesh.
 */
export async function config(
	state: QuestState,
	params: QuestToolParams,
): Promise<QuestResult> {
	return params.ref?.trim() ? setHearing(state, params) : configReport();
}

/**
 * Set how the quest `id` names (else the loaded one) hears the mesh, on
 * its front matter, so it holds through restarts and respawns and
 * every session on it hears the same.
 */
function setHearing(state: QuestState, params: QuestToolParams): QuestResult {
	const said = /^hears=(addressed|all)$/.exec(params.ref?.trim() ?? "")?.at(1);
	if (said !== "addressed" && said !== "all") {
		return refuse(`Nothing changed: ${HEARS_USAGE}`);
	}
	const target = addressOf(state, params.id, { focused: false });
	if ("refusal" in target) return refuse(target.refusal);
	if (target.documentId) {
		return refuse(
			`${target.documentId} is a document; a quest hears the mesh. Name its quest, ${target.questId}, instead.`,
		);
	}
	let changed = false;
	const outcome = mutateQuestFrontMatter(target.questDir, (fm) => {
		const next = said === "addressed" ? "addressed" : undefined;
		if (fm.hears === next) return undefined;
		changed = true;
		return next ? { ...fm, hears: next } : hearsEverything(fm);
	});
	if (!outcome.ok) return refuse(outcome.guidance);
	const how =
		said === "addressed"
			? "only what is put to them, glancing at the rest"
			: "as every peer does";
	if (!changed) {
		return ok(`${target.questId}'s sessions already hear ${how}.`);
	}
	appendJourneyByPath(
		target.questDir,
		`Its sessions now hear the mesh ${how}.`,
	);
	return ok(
		`${target.questId}'s sessions now hear ${how}, from their next delivery.`,
	);
}

/** A quest's front matter without the hearing setting. */
function hearsEverything(fm: QuestFrontMatter): QuestFrontMatter {
	const { hears: _dropped, ...rest } = fm;
	return rest;
}

/** Report the resolved config path and effective values. */
async function configReport(): Promise<QuestResult> {
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
		`Auto-load from cwd: ${summary.autoloadFromCwd} (${summary.autoloadFromCwdSource})`,
		`Spawn into a host: ${summary.spawnHost} (${summary.spawnHostSource})`,
	];
	if (section.warning) lines.push(`Warning: ${section.warning}`);
	lines.push(`A quest's own: ${HEARS_USAGE}`);

	return ok(lines.join("\n"), { summary, warning: section.warning });
}
