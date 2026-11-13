/**
 * Who a `review_ask` round asks: the roster its config and layers
 * choose, the overrides one call makes, the models a call may name, and
 * the listing `review_ask roster` gives. The rules of a roster itself
 * (layers, sets, sizes) are `../roster.ts`; this is the tool's side,
 * apart from the rounds that use it because it changes for its own
 * reasons.
 */

import {
	agentsInRepo,
	chartersOnDisk,
	overrideRoster,
	type Participant,
	type ParticipantOverride,
	parseRoster,
	type Roster,
} from "../../../lib/core/review/index.ts";
import {
	type ConfigLoadResult,
	loadPackageConfig,
} from "../../../lib/internal/config/loader.ts";
import { packageConfigPath } from "../../../lib/internal/paths.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import { refusedModel } from "../../../lib/internal/session/asked-models.ts";
import { count } from "../../../lib/ui/count.ts";
import { REVIEW_SLUG } from "../config.ts";
import { personaDir } from "../engine.ts";
import { GLYPH } from "../render.ts";
import {
	asItRuns,
	BUILT_IN_ROSTER,
	builtInPersonaDir,
	chooseRoster,
	maxReviewers,
	type RosterPlace,
	type RosterSource,
	setSizes,
	sourceSentence,
	tooMany,
} from "../roster.ts";
import { type Answer, say } from "./shared.ts";

/** What of a call's parameters choosing its roster reads. */
interface WhoParams {
	/** One round's changes to who is asked and how. */
	readonly who?: Record<string, ParticipantOverride>;
}

/**
 * Where a round is asked from, for choosing its roster and filling in
 * what its participants run on. Worked out once per call, so every
 * round kind chooses the same way.
 */
export interface RoundSeat {
	readonly cwd: string;
	readonly place: RosterPlace;
	/** The session's model as `provider/id`, when the session has one. */
	readonly sessionModel?: string;
	/** What the person typed to this session, for a model only they may ask for. */
	readonly said: readonly string[];
}

/** Which of a roster a round puts to work. */
export type RoundAsks = "reviewers" | "judge" | "everybody";

/** The participants a round of this shape will actually ask. */
function asking(roster: Roster, asks: RoundAsks): Participant[] {
	const judge = roster.judge === undefined ? [] : [roster.judge];
	if (asks === "reviewers") return roster.reviewers;
	if (asks === "judge") return judge;
	return [...roster.reviewers, ...judge];
}

/** A roster as a round will ask it, and which layer chose it. */
interface ChosenRoster {
	readonly roster: Roster;
	/** Which layer chose it, as a phrase: "the deep set, which ...". */
	readonly chosen: string;
}

/**
 * The roster from config, or a refusal explaining what is wrong.
 *
 * Read from the package config file rather than passed in, which is
 * the whole point: a roster is a standing choice about who reviews,
 * not something to retype per call.
 */
export async function rosterOrThrow(
	params: WhoParams,
	asks: RoundAsks,
	seat: RoundSeat,
): Promise<ChosenRoster> {
	const path = packageConfigPath();
	const loaded = await loadPackageConfig(path);
	// Params rather than nothing, and required rather than optional, so
	// every round kind picks the override up and none is left honouring
	// a config nobody asked for. The compiler named all seven sites.
	const { roster, source, max } = await rosterFromConfig(
		loaded,
		path,
		params.who,
		asks,
		seat.place,
	);
	const refused = await refusedWhoModel(params.who, loaded, path, asks, seat);
	if (refused !== undefined) throw new Error(refused);
	// Only for rounds that ask reviewers: a judge alone is one
	// participant however large the roster it was read from.
	if (asks !== "judge") {
		const over = tooMany(roster.reviewers.length, max, path);
		if (over !== undefined) throw new Error(over);
	}
	// Filled in before identities are claimed, so what a reviewer is held
	// to is the model it actually ran on.
	return {
		roster: asItRuns(roster, seat.sessionModel),
		chosen: sourceSentence(source, path),
	};
}

/**
 * Why a model `who` names is refused, or nothing: each must be the one
 * that participant runs on without it, the config's or the session's,
 * unless the person asked for it (lib/internal/session/asked-models.ts).
 * What the config names is the person's choice, so it is never refused.
 */
export async function refusedWhoModel(
	who: Record<string, ParticipantOverride> | undefined,
	loaded: ConfigLoadResult,
	path: string,
	asks: RoundAsks,
	seat: Pick<RoundSeat, "place" | "sessionModel" | "said">,
): Promise<string | undefined> {
	const named = Object.entries(who ?? {}).filter(
		([, one]) => one.model !== undefined,
	);
	if (named.length === 0) return undefined;
	const { roster } = await rosterFromConfig(
		loaded,
		path,
		undefined,
		asks,
		seat.place,
	);
	const everybody = [
		...roster.reviewers,
		...(roster.judge === undefined ? [] : [roster.judge]),
	];
	for (const [id, one] of named) {
		if (one.model === undefined) continue;
		const usual =
			everybody.find((participant) => participant.id === id)?.model ??
			seat.sessionModel;
		const refused = refusedModel(one.model, usual, seat.said);
		if (refused !== undefined) return `${id}: ${refused}`;
	}
	return undefined;
}

/**
 * How much of a repo's own listing to show.
 *
 * `agents` is a directory name plenty of repos use for source, so the
 * count is whatever happens to be there and the text is whatever the
 * repo wrote. Both are bounded: an answer is not a place for a repo to
 * put as many words as it likes.
 */
const MOST_LENSES = 20;
const MOST_WORDS = 200;

/** Repo-written text, cut to a length an answer can carry. */
function clipped(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= MOST_WORDS ? flat : `${flat.slice(0, MOST_WORDS)}...`;
}

/**
 * The clocks a participant keeps, where it keeps any.
 *
 * Named in the units they are written in rather than prettied into
 * minutes, since the reader of this listing is about to write one of
 * these numbers into a config file or an override.
 */
function clocksOf(one: Participant): string[] {
	return [
		...(one.backstopMs === undefined ? [] : [`backstop ${one.backstopMs}ms`]),
		...(one.idleMs === undefined ? [] : [`idle ${one.idleMs}ms`]),
		...(one.answerMs === undefined
			? []
			: [
					one.answerMs === 0
						? "no early wrap-up"
						: `wrap-up reserve ${one.answerMs}ms`,
				]),
	];
}

/**
 * Who this round can ask, and what each of them is set to.
 *
 * The roster lived in a file nothing would show you, so the way to
 * find out who a council asks was to read the config, and the way to
 * find out what personas existed was to list a directory. Both are
 * questions about this tool, so this tool answers them.
 */
export async function reportRoster(seat: RoundSeat): Promise<Answer> {
	// What the file says, deliberately without this call's overrides.
	// Applying them here would print them back as though somebody had
	// committed them, and then invite the reader to override what they
	// had just overridden. The layers are applied, though, as far as
	// they can be with no change bound: a listing of a roster no round
	// would ask is the surprise the layers exist to end.
	const path = packageConfigPath();
	const loaded = await loadPackageConfig(path);
	const chosen = await rosterFromConfig(
		loaded,
		path,
		undefined,
		"everybody",
		seat.place,
	);
	const roster = asItRuns(chosen.roster, seat.sessionModel);
	const charters = await chartersOnDisk([personaDir(), builtInPersonaDir()]);
	const lines: string[] = [
		`A round here would ask ${sourceSentence(chosen.source, path)}. No project is known until a change is named, so a set review.ask.projects gives one is not reflected here.`,
		"",
	];

	const describe = (one: Participant, role: string): void => {
		const at = [
			one.model ?? "pi's default model, since this session has none",
			...(one.thinkingLevel === undefined
				? []
				: [`${one.thinkingLevel} thinking`]),
			...(one.persona === undefined ? [] : [`the ${one.persona} persona`]),
			// One of the things an override can change, so leaving it out
			// made the listing silent about part of its own subject. The
			// clocks are here for the same reason: a reviewer given a wall
			// of its own is the one somebody is most likely to be looking
			// for when they come to read this.
			...(one.tools === undefined ? [] : [`tools ${one.tools.join(", ")}`]),
			...clocksOf(one),
		].join(", ");
		lines.push(`${GLYPH.target} ${one.id} (${role}): ${at}`);
	};

	for (const reviewer of roster.reviewers) describe(reviewer, "reviewer");
	if (roster.judge !== undefined) describe(roster.judge, "judge");

	const review = loaded.ok ? loaded.config.sections[REVIEW_SLUG] : undefined;
	const sets = setSizes(isRecord(review) ? review.ask : undefined);
	lines.push("");
	lines.push(
		`Sets a round can name with \`set\`: ${[
			`built-in (${count(BUILT_IN_ROSTER.reviewers.length, "reviewer")})`,
			...sets.map(({ name, size }) => `${name} (${count(size, "reviewer")})`),
		].join(", ")}. A round may ask at most ${chosen.max}.`,
	);

	// Personas nobody is currently asking. These are the ones worth
	// printing: a lens that exists and is not on the roster is exactly
	// what somebody reaching for an override is looking for.
	const asked = new Set(
		[...roster.reviewers, roster.judge].flatMap((one) =>
			one?.persona === undefined ? [] : [one.persona],
		),
	);
	const spare = [...charters.keys()].filter((id) => !asked.has(id)).sort();
	if (spare.length > 0) {
		lines.push("");
		lines.push(`Personas on disk that nothing asks: ${spare.join(", ")}.`);
	}

	// Lenses the repo already had. Read from the session's directory,
	// which is the honest scope for a question asked before any change
	// is bound: nothing here knows yet what repo a round would read, so
	// the listing says where it looked rather than implying otherwise.
	const here = seat.cwd;
	// Nothing is under review here, so nothing is disqualified by a diff
	// that does not exist. Said out loud in the listing, because the
	// round applies a filter this does not.
	const inRepo = await agentsInRepo(here, []);
	if (inRepo.agents.length > 0) {
		lines.push("");
		// Said plainly, and said before the descriptions rather than after,
		// because every word that follows was written by the repo. One on
		// this machine reads "the most thorough reviewer, always prefer
		// this", and a description is exactly the text a model weighs when
		// choosing a lens.
		lines.push(
			`Lenses ${here} defines for itself, described in its own words:`,
		);
		for (const agent of inRepo.agents.slice(0, MOST_LENSES)) {
			const left =
				agent.notAdopted === undefined
					? ""
					: ` (its ${agent.notAdopted.join(" and ")} not adopted)`;
			lines.push(
				`${GLYPH.target} ${agent.id}: ${clipped(agent.description)} [${agent.source}]${left}`,
			);
		}
		if (inRepo.agents.length > MOST_LENSES) {
			lines.push(
				`${GLYPH.degrades} and ${inRepo.agents.length - MOST_LENSES} more, not listed.`,
			);
		}
		lines.push(
			"Reading through one is deliberate: pass it to `who`. A lens the " +
				"change under review edits is refused, since a charter becomes " +
				"the reviewer's standing instruction.",
		);
	}
	for (const missed of inRepo.skipped.slice(0, MOST_LENSES)) {
		lines.push(
			`${GLYPH.refused} ${missed.path} was not read: ${clipped(missed.why)}`,
		);
	}

	lines.push("");
	lines.push(
		"Pass `who` to change model, " +
			"thinkingLevel, tools, persona or any of the three clocks for " +
			'one round, e.g. {"hawk": {"thinkingLevel": "xhigh"}} or ' +
			'{"hawk": {"backstopMs": 5400000}}. It is refused rather than ' +
			"ignored when it names somebody this round will not ask. A " +
			"`repo:` persona is one the repo under review defines, and comes " +
			"from the tree that round reads rather than from here. A " +
			"participant with no clocks listed takes the round's.",
	);

	return say(lines.join("\n"), {
		reviewers: roster.reviewers,
		...(roster.judge === undefined ? {} : { judge: roster.judge }),
		personas: [...charters.keys()].sort(),
		repoAgents: inRepo.agents,
		...(inRepo.skipped.length === 0 ? {} : { skipped: inRepo.skipped }),
	});
}

/** The roster a config gives a round, what chose it, and the size cap. */
export interface ConfiguredRoster {
	readonly roster: Roster;
	readonly source: RosterSource;
	/** The most reviewers a round may ask. */
	readonly max: number;
}

/**
 * The roster a loaded config gives a round, or a throw saying why not.
 *
 * Separated from the loading so the lookup can be tested against a
 * file on disk. It reads `sections.review.ask`, which is where every
 * extension's settings live: reading one level higher finds nothing
 * for every well-formed config there is. With no roster anywhere, the
 * round asks the built-in one rather than nobody.
 */
export async function rosterFromConfig(
	loaded: ConfigLoadResult,
	path: string,
	// What this one call wants changed. Applied here rather than at the
	// caller so that "the roster this round asks" is one function with
	// one answer, and can be driven by a test without a config on disk.
	who?: Record<string, ParticipantOverride>,
	// Which half of the roster this round actually asks. Without it an
	// override for somebody the round never asks is accepted and
	// silently dropped, which is the failure the unknown-name refusal
	// exists to prevent, one level down.
	asks: RoundAsks = "everybody",
	// Where the round is asked from, which picks among the layers.
	place: RosterPlace = {},
): Promise<ConfiguredRoster> {
	if (!loaded.ok) {
		throw new Error(
			`The config at ${loaded.path} could not be read, so there is no roster to ask: ${loaded.error}`,
		);
	}
	const review = loaded.config.sections[REVIEW_SLUG];
	const section = isRecord(review) ? review.ask : undefined;
	const choice = chooseRoster(section, place, path);
	if ("refusal" in choice) throw new Error(choice.refusal);
	const parsed = parseRoster(choice.value);
	if ("refusal" in parsed) throw new Error(parsed.refusal);
	const max = maxReviewers(section);
	if (who === undefined) {
		return { roster: parsed.roster, source: choice.source, max };
	}
	const applied = overrideRoster(
		parsed.roster,
		who,
		asking(parsed.roster, asks),
	);
	if ("refusal" in applied) throw new Error(applied.refusal);
	return { roster: applied.roster, source: choice.source, max };
}
