/**
 * The config query verb.
 *
 * Reports where quest-workflow reads its configuration and the
 * effective values, marking each as set in the file or fallen
 * back to a built-in default, so the user can see and trust what
 * the harness is doing without guessing paths. Given a `ref`, it sets a
 * quest's own setting instead: how its sessions hear the mesh; given
 * only an `id`, it says how that quest's sessions hear.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	getSection,
	loadPackageConfig,
} from "../../../lib/internal/config/loader.ts";
import { dataDir, packageConfigPath } from "../../../lib/internal/paths.ts";
import { appendJourneyByPath } from "../../../lib/internal/quest/append-journey.ts";
import { parseQuestFrontMatter } from "../../../lib/internal/quest/frontmatter.ts";
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

/** How a quest's hearing reads, said as its sessions doing it. */
const ONLY_PUT = "only what is put to them, glancing at the rest";
const AS_EVERY_PEER = "as every peer does";

/**
 * Report the config, or with a `ref` set a quest's own setting: how
 * its sessions hear the mesh, which an `id` alone reports.
 */
export async function config(
	state: QuestState,
	params: QuestToolParams,
): Promise<QuestResult> {
	if (params.ref?.trim()) return setHearing(state, params);
	if (params.id?.trim()) return hearingOf(state, params);
	return configReport();
}

/** The quest `id` names, or a refusal saying why it names none. */
function questNamed(
	state: QuestState,
	params: QuestToolParams,
): { questId: string; questDir: string } | { refusal: string } {
	const target = addressOf(state, params.id, { focused: false });
	if ("refusal" in target) return target;
	if (target.documentId) {
		return {
			refusal: `${target.documentId} is a document; a quest hears the mesh. Name its quest, ${target.questId}, instead.`,
		};
	}
	return target;
}

/**
 * How the quest `id` names hears the mesh, naming a way written by hand
 * that can't be read, which leaves it hearing as every peer does.
 */
function hearingOf(state: QuestState, params: QuestToolParams): QuestResult {
	const target = questNamed(state, params);
	if ("refusal" in target) return refuse(target.refusal);
	let fm: QuestFrontMatter | undefined;
	try {
		fm = parseQuestFrontMatter(
			readFileSync(join(target.questDir, "README.md"), "utf8"),
		)?.frontMatter;
	} catch {
		// An unreadable README reads as no front matter, refused below.
	}
	if (!fm) {
		return refuse(`${target.questId}'s README has no readable front matter.`);
	}
	const stray = fm._extra?.hears;
	if (stray !== undefined) {
		const said = JSON.stringify(stray);
		return ok(
			`${target.questId}'s front matter says hears: ${said}, but ${said} isn't a way of hearing, so its sessions hear ${AS_EVERY_PEER}. ${HEARS_USAGE}`,
		);
	}
	const how = fm.hears === "addressed" ? ONLY_PUT : AS_EVERY_PEER;
	return ok(`${target.questId}'s sessions hear ${how}. ${HEARS_USAGE}`);
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
	const target = questNamed(state, params);
	if ("refusal" in target) return refuse(target.refusal);
	let changed = false;
	const outcome = mutateQuestFrontMatter(target.questDir, (fm) => {
		const next = said === "addressed" ? "addressed" : undefined;
		const stray = fm._extra?.hears !== undefined;
		if (fm.hears === next && !stray) return undefined;
		changed = true;
		const plain = hearsEverything(fm);
		return next ? { ...plain, hears: next } : plain;
	});
	if (!outcome.ok) return refuse(outcome.guidance);
	const how = said === "addressed" ? ONLY_PUT : AS_EVERY_PEER;
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

/**
 * A quest's front matter without the hearing setting, a way written by
 * hand it couldn't read included.
 */
function hearsEverything(fm: QuestFrontMatter): QuestFrontMatter {
	const { hears: _dropped, _extra, ...rest } = fm;
	if (!_extra) return rest;
	const { hears: _stray, ...others } = _extra;
	return Object.keys(others).length > 0 ? { ...rest, _extra: others } : rest;
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
		`Start into a host: ${summary.startHost} (${summary.startHostSource})`,
	];
	if (section.warning) lines.push(`Warning: ${section.warning}`);
	lines.push(`A quest's own: ${HEARS_USAGE}`);

	return ok(lines.join("\n"), { summary, warning: section.warning });
}
