/**
 * Which roster a round asks, and what each participant runs on.
 *
 * A round used to have one roster, the one in the config file, and no
 * roster at all where there was no file: every council on a fresh
 * machine was refused. It also had no say over what a participant with
 * no model ran on. The listing called that "the session's own model",
 * and the child took pi's `defaultModel` instead, which is a different
 * model whenever the two differ, and they usually do.
 *
 * So the roster is now chosen, in layers, first match winning: the set
 * a round names, the set the loaded quest names, the set the project
 * names, the roster in the config, and finally one the package ships.
 * Every answer says which layer chose, since a council on the wrong
 * reviewers is the surprise this exists to end.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Participant, Roster } from "../../lib/core/review/index.ts";

/**
 * What a reviewer is given to read with: enough to follow the change
 * into the code around it, and nothing that can change anything.
 */
const READ_ONLY = ["read", "grep", "glob", "ls"] as const;

/**
 * The roster a round asks when nobody has written one.
 *
 * Four lenses that look for different things, which is what makes a
 * council worth more than one reviewer asked four times. The same four
 * a real council on this harness was run with, and small on purpose:
 * a bigger council is a choice somebody makes, with a set of its own.
 * No model, so each runs on the session's.
 */
export const BUILT_IN_ROSTER: Roster = {
	reviewers: [
		"correctness-and-tests",
		"test-skeptic",
		"security-attacker",
		"operational-safety",
	].map((persona) => ({ id: persona, persona, tools: READ_ONLY })),
	judge: { id: "judge", tools: READ_ONLY },
};

/** The name a round uses to ask for the built-in roster outright. */
export const BUILT_IN_SET = "built-in";

/**
 * How hard a participant thinks when nothing says.
 *
 * High rather than pi's own default, because a review is the work a
 * round exists to do, and rather than the highest, which costs far more
 * than the findings it adds.
 */
export const DEFAULT_THINKING = "high";

/**
 * How many reviewers a round may ask unless the config says otherwise.
 *
 * Room for a deliberate deep council and well short of the
 * twenty-two-member one that prompted a cap at all.
 */
export const DEFAULT_MAX_REVIEWERS = 8;

/** Where the package's own persona charters live. */
export function builtInPersonaDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "personas");
}

/** What a round knows about where it is, for choosing a roster. */
export interface RosterPlace {
	/** The set this round named, if it named one. */
	readonly set?: string;
	/** The quest the session has loaded, if any. */
	readonly quest?: string;
	/** The repository the change belongs to, e.g. `github:Shopify/world`. */
	readonly project?: string;
}

/** Which layer picked the roster, said in one sentence. */
export type RosterSource =
	| { readonly kind: "round"; readonly set: string }
	| { readonly kind: "quest"; readonly quest: string; readonly set: string }
	| { readonly kind: "project"; readonly project: string; readonly set: string }
	| { readonly kind: "config" }
	| { readonly kind: "built-in" };

/** The unparsed roster a layer chose, or why the choice failed. */
export type RosterChoice =
	| { readonly value: unknown; readonly source: RosterSource }
	| { readonly refusal: string };

/**
 * Pick the roster this round asks, before it is parsed.
 *
 * `section` is `review.ask` as the config holds it, which may be
 * missing or malformed; `path` is the file, for refusals that say
 * where to look.
 */
export function chooseRoster(
	section: unknown,
	place: RosterPlace,
	path: string,
): RosterChoice {
	const ask = isRecord(section) ? section : {};
	const sets = isRecord(ask.sets) ? ask.sets : {};
	const named = (set: string, where: string): RosterChoice | undefined => {
		if (set === BUILT_IN_SET) return undefined;
		if (set in sets) return undefined;
		const known = [BUILT_IN_SET, ...Object.keys(sets)].join(", ");
		return {
			refusal: `${where} names the set "${set}", and ${path} has no review.ask.sets.${set}. Sets it has: ${known}.`,
		};
	};
	const of = (set: string): unknown =>
		set === BUILT_IN_SET ? BUILT_IN_ROSTER : sets[set];

	if (place.set !== undefined) {
		const wrong = named(place.set, "This round");
		if (wrong !== undefined) return wrong;
		return { value: of(place.set), source: { kind: "round", set: place.set } };
	}
	const byQuest = lookup(ask.quests, place.quest);
	if (byQuest !== undefined && place.quest !== undefined) {
		const wrong = named(byQuest, `review.ask.quests.${place.quest}`);
		if (wrong !== undefined) return wrong;
		return {
			value: of(byQuest),
			source: { kind: "quest", quest: place.quest, set: byQuest },
		};
	}
	const byProject = lookup(ask.projects, place.project);
	if (byProject !== undefined && place.project !== undefined) {
		const wrong = named(byProject, `review.ask.projects["${place.project}"]`);
		if (wrong !== undefined) return wrong;
		return {
			value: of(byProject),
			source: { kind: "project", project: place.project, set: byProject },
		};
	}
	if (ask.reviewers !== undefined || ask.judge !== undefined) {
		return { value: ask, source: { kind: "config" } };
	}
	return { value: BUILT_IN_ROSTER, source: { kind: "built-in" } };
}

/** Which set a map names for one key, when it names one. */
function lookup(map: unknown, key: string | undefined): string | undefined {
	if (key === undefined || !isRecord(map)) return undefined;
	const set = map[key];
	return typeof set === "string" && set.trim() !== "" ? set : undefined;
}

/** One sentence saying which layer chose a round's roster. */
export function sourceSentence(source: RosterSource, path: string): string {
	switch (source.kind) {
		case "round":
			return `the ${source.set} set, which this round named`;
		case "quest":
			return `the ${source.set} set, which review.ask.quests names for ${source.quest}`;
		case "project":
			return `the ${source.set} set, which review.ask.projects names for ${source.project}`;
		case "config":
			return `the roster in ${path}`;
		case "built-in":
			return `the built-in roster, since ${path} has none; write a review.ask roster there, or sets under review.ask.sets, to choose your own`;
	}
}

/**
 * Every participant as it will actually run.
 *
 * A participant with no model takes the session's, written out, so the
 * child is told rather than left to pi's `defaultModel`. One with no
 * thinking level takes the default. Without a session model, the model
 * is left as it is, and the child falls back the way it always did.
 */
export function asItRuns(roster: Roster, sessionModel?: string): Roster {
	const fill = (one: Participant): Participant => ({
		...one,
		...(one.model === undefined && sessionModel !== undefined
			? { model: sessionModel }
			: {}),
		...(one.thinkingLevel === undefined
			? { thinkingLevel: DEFAULT_THINKING }
			: {}),
	});
	return {
		reviewers: roster.reviewers.map(fill),
		...(roster.judge === undefined ? {} : { judge: fill(roster.judge) }),
	};
}

/**
 * Each named set and how many reviewers it asks, for the listing.
 * A set that would not parse counts what its reviewers array holds,
 * since the round that names it says what is wrong with it.
 */
export function setSizes(
	section: unknown,
): { readonly name: string; readonly size: number }[] {
	const sets = isRecord(section) && isRecord(section.sets) ? section.sets : {};
	return Object.entries(sets)
		.map(([name, set]) => ({
			name,
			size:
				isRecord(set) && Array.isArray(set.reviewers)
					? set.reviewers.length
					: 0,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The most reviewers a round may ask, as the config sets it. */
export function maxReviewers(section: unknown): number {
	const said = isRecord(section) ? section.maxReviewers : undefined;
	return typeof said === "number" && Number.isInteger(said) && said > 0
		? said
		: DEFAULT_MAX_REVIEWERS;
}

/** Why a round of this size is refused, or undefined when it fits. */
export function tooMany(
	asking: number,
	max: number,
	path: string,
): string | undefined {
	if (asking <= max) return undefined;
	return `This round would ask ${asking} reviewers and the most a round may ask is ${max}. Pick a smaller set, or raise review.ask.maxReviewers in ${path} if a council this size is what you mean.`;
}

/** Whether a value is an object we can read keys off. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
