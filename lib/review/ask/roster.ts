/**
 * Who gets asked about a change.
 *
 * A roster comes from config rather than from the tool surface, so
 * it arrives as whatever was in a file. Everything here is about
 * turning that into participants or saying precisely what was
 * wrong with it, since a config error found at fan-out time has
 * already cost the caller a wait.
 *
 * Every refusal names the path it found the trouble at. A sentence
 * saying a roster is invalid is true and useless when the roster
 * has six reviewers.
 */

import { isThinkingLevel, THINKING_LEVELS } from "../../thinking/index.js";
import type { Participant, ParticipantClocks } from "./identity.js";

/** Settings a call may change for one round. */
export interface ParticipantOverride {
	model?: string;
	thinkingLevel?: string;
	tools?: readonly string[];
	/**
	 * The lens to read through for this round.
	 *
	 * This was deliberately left out at first, on the reasoning that a
	 * lens belongs to a participant and a spare one is a roster entry.
	 * Repo agents made that wrong. The roster is one file for every repo
	 * an operator reviews in, and a repo's own lenses exist only in that
	 * repo, so a global entry naming one is a line that refuses
	 * everywhere else. Per-round is the only scope that fits.
	 */
	persona?: string;
	/**
	 * Clocks for this one round.
	 *
	 * The adjustment somebody makes right after being told a reviewer
	 * ran out of time, which is exactly when editing a committed file
	 * and running again is the wrong shape. Unlike the model and the
	 * thinking level, these do not change what a finding means, so the
	 * identity ledger does not hold an id to them.
	 */
	backstopMs?: number;
	idleMs?: number;
	answerMs?: number;
}

/**
 * Apply per-call settings to a roster, or say why they cannot be.
 *
 * The roster is what somebody committed to a file; an override is what
 * they want for this one round. Trying a reviewer on a different model
 * used to mean editing the file, running, and editing it back, while
 * the fan-out tool next door has taken these per call since it was
 * written.
 *
 * Every override goes through the same parse the config does, so a
 * level pi would reject and a model carrying a colon are refused
 * identically wherever they were written down. A name nobody answers
 * to is refused rather than ignored: silently doing nothing means the
 * round runs, costs what it costs, and never applies the setting that
 * was the reason for asking.
 */
export function overrideRoster(
	roster: Roster,
	overrides: Record<string, ParticipantOverride>,
	// Who this round will actually ask, when that is narrower than the
	// roster. Checking against the roster alone accepts an override for
	// somebody this round never asks, which is the same silent drop the
	// unknown-name refusal exists to prevent, one level down: a council
	// does not ask the judge, so tuning the judge for a council did
	// nothing and said nothing.
	asks: readonly Participant[] = [
		...roster.reviewers,
		...(roster.judge === undefined ? [] : [roster.judge]),
	],
): RosterParse {
	const everybody = [
		...roster.reviewers,
		...(roster.judge === undefined ? [] : [roster.judge]),
	];
	const asked = new Set(asks.map((one) => one.id));
	const strangers = Object.keys(overrides).filter((id) => !asked.has(id));
	if (strangers.length > 0) {
		const named = new Set(everybody.map((one) => one.id));
		const onRoster = strangers.filter((id) => named.has(id));
		return {
			refusal:
				onRoster.length > 0
					? `This round does not ask ${onRoster.map((id) => `"${id}"`).join(", ")}, so setting anything for them would do nothing. It asks ${[...asked].map((id) => `"${id}"`).join(", ")}.`
					: `This roster has nobody called ${strangers.map((id) => `"${id}"`).join(", ")}. It asks ${[...named].map((id) => `"${id}"`).join(", ")}.`,
		};
	}

	const applied = new Map<string, Participant>();
	for (const participant of everybody) {
		const over = overrides[participant.id];
		if (over === undefined) {
			applied.set(participant.id, participant);
			continue;
		}
		// Named fields rather than a spread of whatever arrived. The type
		// says four, and a type says nothing at runtime: spreading let a
		// caller set `id` through a door meant for settings, and a changed
		// id would slip past the collision check that only runs when a
		// whole roster is parsed.
		const parsed = parseParticipant(
			{
				...participant,
				...(over.model === undefined ? {} : { model: over.model }),
				...(over.thinkingLevel === undefined
					? {}
					: { thinkingLevel: over.thinkingLevel }),
				...(over.tools === undefined ? {} : { tools: over.tools }),
				...(over.persona === undefined ? {} : { persona: over.persona }),
				...(over.backstopMs === undefined
					? {}
					: { backstopMs: over.backstopMs }),
				...(over.idleMs === undefined ? {} : { idleMs: over.idleMs }),
				...(over.answerMs === undefined ? {} : { answerMs: over.answerMs }),
			},
			`the override for "${participant.id}"`,
		);
		if ("refusal" in parsed) return parsed;
		applied.set(participant.id, parsed.participant);
	}

	const judge = roster.judge;
	return {
		roster: {
			reviewers: roster.reviewers.map((one) => applied.get(one.id) ?? one),
			...(judge === undefined ? {} : { judge: applied.get(judge.id) ?? judge }),
		},
	};
}

/** Who to ask, and who consolidates what they say. */
export interface Roster {
	reviewers: Participant[];
	judge?: Participant;
}

/** A roster, or the reason there is not one. */
export type RosterParse = { roster: Roster } | { refusal: string };

/** One participant, or the reason there is not one. */
export type ParticipantParse =
	| { participant: Participant }
	| { refusal: string };

/**
 * Read one participant out of untrusted config.
 *
 * A participant with a persona and no id takes the persona's name,
 * because naming a reviewer twice to say one thing is noise and the
 * persona is the more meaningful of the two. An explicit id wins,
 * which is how the same persona runs twice at different settings.
 */
export function parseParticipant(
	value: unknown,
	path: string,
): ParticipantParse {
	if (!isRecord(value)) {
		return {
			refusal: `${path} must be an object describing a participant, with an id or a persona.`,
		};
	}

	const persona = optionalText(value, "persona", path);
	if ("refusal" in persona) return persona;
	const id = optionalText(value, "id", path);
	if ("refusal" in id) return id;
	const model = optionalText(value, "model", path);
	if ("refusal" in model) return model;
	const thinkingLevel = optionalText(value, "thinkingLevel", path);
	if ("refusal" in thinkingLevel) return thinkingLevel;

	const name = id.text ?? persona.text;
	if (name === undefined) {
		return {
			refusal: `${path} names nobody. Give it an id, or a persona whose id it can take.`,
		};
	}

	if (model.text?.includes(":")) {
		// Pi reads a colon as a thinking-level separator, so a model
		// carrying one silently becomes a different request than the
		// one written down. Refusing beats sending something nobody
		// asked for.
		return {
			refusal: `${path}.model is "${model.text}", and a colon there reads as a thinking-level separator rather than part of the model name. Write the model with a slash, and set thinkingLevel separately.`,
		};
	}

	if (
		thinkingLevel.text !== undefined &&
		!isThinkingLevel(thinkingLevel.text)
	) {
		// Read as any non-blank string until now, so a typo went to pi's
		// --thinking flag and the reviewer ran at whatever pi makes of a
		// level it does not know. The one place this can be caught is
		// here, before anybody is asked and before anybody is billed.
		return {
			refusal: `${path}.thinkingLevel is "${thinkingLevel.text}", which pi does not accept. Use one of ${THINKING_LEVELS.join(", ")}.`,
		};
	}

	const tools = optionalTools(value, path);
	if ("refusal" in tools) return tools;

	const clocks = optionalClocks(value, path);
	if ("refusal" in clocks) return clocks;

	return {
		participant: {
			id: name,
			...(persona.text === undefined ? {} : { persona: persona.text }),
			...(model.text === undefined ? {} : { model: model.text }),
			...(thinkingLevel.text === undefined
				? {}
				: { thinkingLevel: thinkingLevel.text }),
			...(tools.tools === undefined ? {} : { tools: tools.tools }),
			...clocks.clocks,
		},
	};
}

/**
 * Read a whole roster out of untrusted config.
 *
 * Ids are checked for collisions after persona naming rather than
 * before, since one entry named by its persona and one named
 * explicitly can collide in a way that is invisible in the file.
 */
export function parseRoster(value: unknown): RosterParse {
	if (!isRecord(value)) {
		return {
			refusal:
				"A roster must be an object with a reviewers array, and optionally a judge.",
		};
	}

	if (!("reviewers" in value) || value.reviewers === undefined) {
		return {
			refusal:
				"This roster names no reviewers. Add a reviewers array holding at least one participant.",
		};
	}
	if (!Array.isArray(value.reviewers)) {
		return { refusal: "reviewers must be an array of participants." };
	}
	if (value.reviewers.length === 0) {
		// A council of nobody is not a smaller council. Running one
		// would report success having asked no one, which is worse than
		// refusing.
		return {
			refusal:
				"reviewers is empty, so there is nobody to ask. Add at least one participant.",
		};
	}

	const reviewers: Participant[] = [];
	const taken = new Map<string, string>();
	for (const [index, entry] of value.reviewers.entries()) {
		const path = `reviewers[${index}]`;
		const parsed = parseParticipant(entry, path);
		if ("refusal" in parsed) return parsed;
		const claimed = taken.get(parsed.participant.id);
		if (claimed !== undefined) {
			// Two participants under one name make every origin
			// mentioning it ambiguous, which is what the identity ledger
			// exists to prevent. Catching it here is much cheaper.
			return {
				refusal: `${path} and ${claimed} are both called "${parsed.participant.id}", so nothing they raise could be told apart. Give one of them a different id.`,
			};
		}
		taken.set(parsed.participant.id, path);
		reviewers.push(parsed.participant);
	}

	if (!("judge" in value) || value.judge === undefined) {
		return { roster: { reviewers } };
	}

	const judge = parseParticipant(value.judge, "judge");
	if ("refusal" in judge) return judge;
	const claimed = taken.get(judge.participant.id);
	if (claimed !== undefined) {
		// The judge reads the reviewers' findings, so sharing a name
		// makes the consolidation indistinguishable from the thing it
		// consolidated.
		return {
			refusal: `The judge is called "${judge.participant.id}", which is already ${claimed}. A judge reads what the reviewers said, so it needs a name of its own.`,
		};
	}

	return { roster: { reviewers, judge: judge.participant } };
}

/** A plain object, as against an array or a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string field that may be absent, refused if present and wrong. */
function optionalText(
	value: Record<string, unknown>,
	key: string,
	path: string,
): { text?: string } | { refusal: string } {
	if (!(key in value) || value[key] === undefined) return {};
	const held = value[key];
	if (typeof held !== "string") {
		return { refusal: `${path}.${key} must be a string.` };
	}
	const text = held.trim();
	if (text === "") {
		return {
			refusal: `${path}.${key} is blank. Give it a value, or leave it out.`,
		};
	}
	return { text };
}

/**
 * The clocks this participant sets for itself, if it sets any.
 *
 * Refused rather than ignored where the number cannot be used, on the
 * same reasoning the model and the thinking level get: a clock written
 * down and silently dropped is a reviewer running under settings
 * nobody chose, and the one place to catch it is before anybody is
 * asked and before anybody is billed.
 *
 * Zero passes only for `answerMs`, which is the documented way to say
 * do not interrupt me early. A zero wall or a zero idle clock stops
 * the reviewer the instant it starts, which nobody writing one meant.
 */
function optionalClocks(
	value: Record<string, unknown>,
	path: string,
): { clocks: ParticipantClocks } | { refusal: string } {
	const clocks: ParticipantClocks = {};
	for (const key of ["backstopMs", "idleMs", "answerMs"] as const) {
		if (!(key in value) || value[key] === undefined) continue;
		const held = value[key];
		if (typeof held !== "number" || !Number.isFinite(held)) {
			return {
				refusal: `${path}.${key} must be a number of milliseconds.`,
			};
		}
		if (held < 0 || (held === 0 && key !== "answerMs")) {
			return {
				refusal:
					`${path}.${key} is ${held}, which would stop this reviewer ` +
					`the moment it started. Give it a duration in milliseconds, ` +
					`or leave it out to take the round's.`,
			};
		}
		clocks[key] = held;
	}
	return { clocks };
}

/** The tool palette, refused as a whole if any entry is not a name. */
function optionalTools(
	value: Record<string, unknown>,
	path: string,
): { tools?: string[] } | { refusal: string } {
	if (!("tools" in value) || value.tools === undefined) return {};
	if (!Array.isArray(value.tools)) {
		return { refusal: `${path}.tools must be an array of tool names.` };
	}
	if (value.tools.length === 0) {
		// It reads as "no tools at all" and means the opposite: the runner
		// treats an empty palette as none given and hands over the default
		// one. So a reviewer meant to be blind would have got everything,
		// and the ledger would have recorded a palette it never had.
		return {
			refusal: `${path}.tools is empty, which reads as no tools but gives the reviewer the default palette. Name the tools it may reach, or leave tools out.`,
		};
	}
	const tools: string[] = [];
	for (const [index, entry] of value.tools.entries()) {
		if (typeof entry !== "string" || entry.trim() === "") {
			return {
				refusal: `${path}.tools[${index}] must be a tool name.`,
			};
		}
		tools.push(entry.trim());
	}
	return { tools };
}
