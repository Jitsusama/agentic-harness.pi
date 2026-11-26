/**
 * The config query verb.
 *
 * Reports where quest-workflow reads its configuration and the
 * effective values, marking each as set in the file or fallen
 * back to a built-in default, so the user can see and trust what
 * the harness is doing without guessing paths. Given a `ref`, it sets a
 * quest's own setting instead: how its sessions hear the mesh, the
 * subjects they say they work on, or whether it is the person's
 * steward; given only an `id`, it says all three.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hosted, sessionEnv } from "../../../lib/core/session/index.ts";
import {
	getSection,
	loadPackageConfig,
} from "../../../lib/internal/config/loader.ts";
import { dataDir, packageConfigPath } from "../../../lib/internal/paths.ts";
import { appendJourneyByPath } from "../../../lib/internal/quest/documents/append-journey.ts";
import { parseQuestFrontMatter } from "../../../lib/internal/quest/documents/frontmatter.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/fields/mutate.ts";
import { stewards } from "../../../lib/internal/quest/fields/orchestration.ts";
import { questAddress } from "../../../lib/mesh/address.ts";
import {
	hubTakesNone,
	LONGEST_WORD,
	overLongWords,
	routingWords,
} from "../../../lib/mesh/need-route.ts";
import {
	declaredSubjects,
	LONGEST_SUBJECT,
	MOST_SUBJECTS,
	ownedPrefixes,
	ownerLinesAt,
	ownersFile,
	subjectsOf,
} from "../../../lib/mesh/subjects.ts";
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

/** How the report says a quest's subjects are set, and the refusal too. */
const SUBJECTS_USAGE = `config with id and ref subjects=a,b sets the subjects a quest's sessions say they work on, after the owner prefixes the machine's config names its address for, ${MOST_SUBJECTS} places in all, so a need on the mesh finds them by those; subjects= clears them.`;

/** The ref that sets a quest's subjects, before its list. */
const SUBJECTS_REF = "subjects=";

/** How the report says a quest is made the person's steward. */
const STEWARD_USAGE =
	"config with id and ref steward=true makes a quest the person's steward, whose session carries what needs the person from every quest below it, up to the next steward, and nothing else; steward=false clears it.";

/** The ref that says whether a quest is the person's steward. */
const STEWARD_REF = "steward=";

/** Every setting a quest's own `ref` can name, for a refusal or report. */
const USAGE = `${HEARS_USAGE} ${SUBJECTS_USAGE} ${STEWARD_USAGE}`;

/** How a quest's hearing reads, said as its sessions doing it. */
const ONLY_PUT = "only what is put to them, glancing at the rest";
const AS_EVERY_PEER = "as every peer does";

/**
 * Report the config, or with a `ref` set a quest's own setting: how
 * its sessions hear the mesh, or the subjects they say they work on,
 * both of which an `id` alone reports.
 */
export async function config(
	state: QuestState,
	params: QuestToolParams,
): Promise<QuestResult> {
	if (params.ref?.trim().startsWith(SUBJECTS_REF)) {
		return setSubjects(state, params);
	}
	if (params.ref?.trim().startsWith(STEWARD_REF)) {
		return setSteward(state, params);
	}
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
	const declare = `${subjectsSaid(target.questId, fm)}${stewardSaid(fm)}`;
	const stray = fm._extra?.hears;
	if (stray !== undefined) {
		const said = JSON.stringify(stray);
		return ok(
			`${target.questId}'s front matter says hears: ${said}, but ${said} isn't a way of hearing, so its sessions hear ${AS_EVERY_PEER}. ${declare} ${USAGE}`,
		);
	}
	const how = fm.hears === "addressed" ? ONLY_PUT : AS_EVERY_PEER;
	return ok(`${target.questId}'s sessions hear ${how}. ${declare} ${USAGE}`);
}

/**
 * The owner prefixes the machine's config names the quest's address
 * for, which its signing session says first; a session's own address
 * may own more, which only it knows. Read through the session's own
 * environment, as presence reads it, so under a host the two agree.
 */
function ownedByQuest(questId: string): string[] {
	const env = hosted() ? sessionEnv().snapshot() : process.env;
	return ownedPrefixes(ownerLinesAt(ownersFile(env)), [questAddress(questId)]);
}

/**
 * What the quest's sessions say they work on, as presence publishes
 * it: what they own, then what the README declares, naming any of
 * those the node would pass over or the places would leave out, and
 * which it declares name no work a need is routed by or say a word
 * whose hub no need reaches. What it owns is
 * the machine's config, which `subjects=` can't change, so it is left
 * out of those.
 */
function subjectsSaid(questId: string, fm: QuestFrontMatter): string {
	const owned = subjectsOf(ownedByQuest(questId), []);
	const declared = declaredSubjects(fm._extra?.subjects);
	const said = subjectsOf(owned, declared);
	const left = declared.filter((one) => !said.includes(one));
	const silent = said.filter(
		(one) => declared.includes(one) && namesNoWork(one),
	);
	// Set by hand or before config refused them, so said here, where
	// their hubs would otherwise go quiet unseen (#2220's fifth council,
	// F3, F7, F9 and F11).
	const hubless = said.filter(
		(one) => declared.includes(one) && !namesNoWork(one) && hubTakesNone(one),
	);
	const parts = [
		said.length > 0
			? `They say they work on ${said.join(", ")}`
			: "They say they work on nothing",
	];
	if (silent.length > 0) {
		parts.push(
			`of which ${silent.join(", ")} ${silent.length === 1 ? "names" : "name"} no work a need is routed by`,
		);
	}
	if (hubless.length > 0) {
		parts.push(
			`of which ${hubless.join(", ")} ${hubless.length === 1 ? "says a word" : "say words"} past ${LONGEST_WORD} characters, which no need keeps, so ${hubless.length === 1 ? "its hub takes" : "their hubs take"} none`,
		);
	}
	if (owned.length > 0) parts.push(`owning ${owned.join(", ")}`);
	if (left.length > 0) {
		parts.push(`leaving out ${left.length} its README declares`);
	}
	return `${parts.join(", ")}.`;
}

/**
 * Whether a subject names no work a need is routed by: its narrowest
 * part, after its last colon, dot or slash with a `.service` ending
 * set aside, holds no word routing reads, as x:can or hooks:after, so
 * no need ever finds a cell by it.
 */
function namesNoWork(subject: string): boolean {
	return routingWords(subject).length === 0;
}

/**
 * Set the subjects the quest `id` names (else the loaded one) says its
 * sessions work on, on its front matter, so every session on it declares
 * the same; an empty list clears them. Refused, changing nothing, when
 * the node would read fewer than were said, or when one names no work a
 * need is routed by.
 */
function setSubjects(state: QuestState, params: QuestToolParams): QuestResult {
	const target = questNamed(state, params);
	if ("refusal" in target) return refuse(target.refusal);
	const listed = (params.ref ?? "").trim().slice(SUBJECTS_REF.length);
	const said = [...new Set(declaredSubjects(listed.split(",")))];
	const subjects = subjectsOf([], said);
	if (subjects.length < said.length) {
		const dropped = said.filter((one) => !subjects.includes(one));
		return refuse(
			`Nothing changed: mycelium's node reads at most ${MOST_SUBJECTS} subjects, each plain text of at most ${LONGEST_SUBJECT} characters, and would pass over ${dropped.length} of these. ${SUBJECTS_USAGE}`,
		);
	}
	const silent = subjects.filter(namesNoWork);
	if (silent.length > 0) {
		return refuse(
			`Nothing changed: a need finds a cell by the words of a subject's narrowest part, after its last colon, dot or slash with a .service ending set aside, and ${silent.join(", ")} ${silent.length === 1 ? "holds" : "hold"} none there, each word too short, too long or as common as can or after. Name the work itself there. ${SUBJECTS_USAGE}`,
		);
	}
	const overLong = subjects.flatMap((one) =>
		overLongWords(one).map((word) => `${word} in ${one}`),
	);
	if (overLong.length > 0) {
		return refuse(
			`Nothing changed: a subject's hub takes a need only when it says every word of the subject's narrowest part, and no need keeps a word past ${LONGEST_WORD} characters, so its hub would take none for ${overLong.join(", ")}. Name the work there in shorter words. ${SUBJECTS_USAGE}`,
		);
	}
	const owned = subjectsOf(ownedByQuest(target.questId), []);
	const published = subjectsOf(owned, subjects);
	const crowded = subjects.filter((one) => !published.includes(one));
	if (crowded.length > 0) {
		return refuse(
			`Nothing changed: the machine's config names ${target.questId} the owner of ${owned.join(", ")}, which take ${owned.length} of the ${MOST_SUBJECTS} places first, so ${crowded.length} of these would never be said. ${SUBJECTS_USAGE}`,
		);
	}
	let changed = false;
	const outcome = mutateQuestFrontMatter(target.questDir, (fm) => {
		const before = JSON.stringify(fm._extra?.subjects ?? []);
		if (before === JSON.stringify(subjects)) return undefined;
		changed = true;
		const { subjects: _dropped, ...others } = fm._extra ?? {};
		const extra = subjects.length > 0 ? { ...others, subjects } : others;
		const { _extra: _old, ...rest } = fm;
		return Object.keys(extra).length > 0 ? { ...rest, _extra: extra } : rest;
	});
	if (!outcome.ok) return refuse(outcome.guidance);
	const what =
		subjects.length > 0
			? `say they work on ${subjects.join(", ")}`
			: "declare no subjects of their own";
	if (!changed) return ok(`${target.questId}'s sessions already ${what}.`);
	appendJourneyByPath(target.questDir, `Its sessions now ${what}.`);
	return ok(
		`${target.questId}'s sessions now ${what}, from their next refresh, so a need on the mesh about those finds them.`,
	);
}

/**
 * Set how the quest `id` names (else the loaded one) hears the mesh, on
 * its front matter, so it holds through restarts and respawns and
 * every session on it hears the same.
 */
function setHearing(state: QuestState, params: QuestToolParams): QuestResult {
	const said = /^hears=(addressed|all)$/.exec(params.ref?.trim() ?? "")?.at(1);
	if (said !== "addressed" && said !== "all") {
		return refuse(`Nothing changed: ${USAGE}`);
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
 * Make the quest `id` names (else the loaded one) the person's steward,
 * or no longer, on its front matter, so every session below it finds
 * the same steward by walking up its parents.
 */
function setSteward(state: QuestState, params: QuestToolParams): QuestResult {
	const said = /^steward=(true|false)$/.exec(params.ref?.trim() ?? "")?.at(1);
	if (said === undefined) return refuse(`Nothing changed: ${USAGE}`);
	const target = questNamed(state, params);
	if ("refusal" in target) return refuse(target.refusal);
	const next = said === "true";
	let changed = false;
	const outcome = mutateQuestFrontMatter(target.questDir, (fm) => {
		const stray = fm._extra?.steward !== undefined;
		if (fm.steward === (next || undefined) && !stray) return undefined;
		changed = true;
		const plain = withoutSteward(fm);
		return next ? { ...plain, steward: true } : plain;
	});
	if (!outcome.ok) return refuse(outcome.guidance);
	const what = next
		? "is the person's steward, carrying what needs the person from every quest below it"
		: "is not the person's steward";
	if (!changed) return ok(`${target.questId} already ${what}.`);
	appendJourneyByPath(target.questDir, `It now ${what}.`);
	return ok(
		`${target.questId} now ${what}, from each session's next refresh of its quest.`,
	);
}

/**
 * Whether a quest is the person's steward, said after its subjects,
 * naming a steward written by hand that can't be read, which makes it
 * none.
 */
function stewardSaid(fm: QuestFrontMatter): string {
	if (stewards(fm)) return " It is the person's steward.";
	const stray = fm._extra?.steward;
	if (stray === undefined) return "";
	const said = JSON.stringify(stray);
	return ` Its front matter says steward: ${said}, but only true makes a steward, so it is not the person's steward.`;
}

/**
 * A quest's front matter without the steward setting, one written by
 * hand that the parser left in `_extra` included.
 */
function withoutSteward(fm: QuestFrontMatter): QuestFrontMatter {
	const { steward: _dropped, _extra, ...rest } = fm;
	if (!_extra) return rest;
	const { steward: _stray, ...others } = _extra;
	return Object.keys(others).length > 0 ? { ...rest, _extra: others } : rest;
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
	lines.push(`A quest's own: ${USAGE}`);

	return ok(lines.join("\n"), { summary, warning: section.warning });
}
