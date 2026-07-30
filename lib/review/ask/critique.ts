/**
 * Pushing back on what a judge concluded.
 *
 * A critique records **positions, not findings**. A critic that could
 * also raise findings would make the round both a discovery pass and a
 * challenge to one, and neither could be read on its own afterwards.
 * So the output is a position per finding with the argument for it,
 * and the run's outcomes carry no finding ids at all.
 *
 * Silence about a finding is no position, never assent. Reading an
 * absent critique as agreement would manufacture consensus out of a
 * critic that ran out of budget, which is the worst way to be wrong
 * here: it makes a weakly supported finding look corroborated.
 */

import type { AskAnswer } from "./council.js";
import { type Participant, participantIdentity } from "./identity.js";
import type { Roster } from "./roster.js";
import { type AskRun, newRunId, type ParticipantOutcome } from "./run.js";

/** Where a critic stands on a finding. */
export type Position = "agree" | "disagree" | "qualify" | "unsure";

/** One critic's position on one finding. */
export interface Critique {
	findingId: number;
	participantId: string;
	position: Position;
	rationale: string;
}

/** What came out of one critic's answer. */
export interface CritiqueHarvest {
	critiques: Critique[];
	warnings: string[];
}

/** The impure things a critique needs. */
export interface CritiqueDeps {
	ask(participant: Participant, prompt: string): Promise<AskAnswer>;
	now(): Date;
}

/** What to put to whom. */
export interface CritiqueRequest {
	roster: Roster;
	prompt: string;
	seq: number;
	/** The findings being put up for challenge. */
	findingIds: number[];
}

/** The round, the positions taken, and anything worth saying. */
export interface CritiqueResult {
	run: AskRun;
	critiques: Critique[];
	warnings: string[];
}

/** The positions a critic may take. */
const POSITIONS: readonly string[] = ["agree", "disagree", "qualify", "unsure"];

/** Read one critic's answer, warning about what it dropped. */
export function harvestCritiques(
	text: string,
	participantId: string,
	findingIds: readonly number[],
): CritiqueHarvest {
	const parsed = findJson(text);
	const held = parsed?.critiques;
	if (!Array.isArray(held)) {
		return {
			critiques: [],
			warnings: [
				"Nothing in this answer parsed as a critiques array, so no positions could be read from it.",
			],
		};
	}

	const put = new Set(findingIds);
	const critiques: Critique[] = [];
	const warnings: string[] = [];
	for (const [index, entry] of held.entries()) {
		const one = readCritique(entry, index, participantId, put, warnings);
		if (one !== undefined) critiques.push(one);
	}
	return { critiques, warnings };
}

/** Put a judge's findings to the roster and gather what they say. */
export async function runCritique(
	request: CritiqueRequest,
	deps: CritiqueDeps,
): Promise<CritiqueResult> {
	const startedAt = deps.now();
	const id = newRunId("critique", startedAt, request.seq);

	// Asking six models to push back on an empty list is a bill for
	// nothing, so a round with nothing to challenge asks nobody and
	// says so by holding no participants.
	if (request.findingIds.length === 0) {
		return {
			run: {
				id,
				round: "critique",
				startedAt: startedAt.toISOString(),
				participants: [],
				outcomes: [],
			},
			critiques: [],
			warnings: [],
		};
	}

	const replies = await Promise.all(
		request.roster.reviewers.map(async (participant) => ({
			participant,
			answer: await asked(participant, request.prompt, deps),
		})),
	);

	const critiques: Critique[] = [];
	const warnings: string[] = [];
	const outcomes: ParticipantOutcome[] = [];
	// In roster order, so a report of the round reads the same way
	// whoever answered first.
	for (const { participant, answer } of replies) {
		if ("failure" in answer) {
			outcomes.push({
				participantId: participant.id,
				findingIds: [],
				failure: answer.failure,
			});
			continue;
		}
		const harvest = harvestCritiques(
			answer.text,
			participant.id,
			request.findingIds,
		);
		critiques.push(...harvest.critiques);
		for (const warning of harvest.warnings) {
			warnings.push(`${participant.id}: ${warning}`);
		}
		outcomes.push({
			participantId: participant.id,
			// A critique raises no findings, on purpose.
			findingIds: [],
			...(answer.usage === undefined ? {} : { usage: answer.usage }),
		});
	}

	return {
		run: {
			id,
			round: "critique",
			startedAt: startedAt.toISOString(),
			participants: request.roster.reviewers.map((participant) =>
				participantIdentity("reviewer", participant),
			),
			outcomes,
		},
		critiques,
		warnings,
	};
}

/** Ask one critic, turning a thrown error into a reported one. */
async function asked(
	participant: Participant,
	prompt: string,
	deps: CritiqueDeps,
): Promise<AskAnswer> {
	try {
		return await deps.ask(participant, prompt);
	} catch (error) {
		return { failure: error instanceof Error ? error.message : String(error) };
	}
}

/** One critique, or nothing plus a warning saying why. */
function readCritique(
	entry: unknown,
	index: number,
	participantId: string,
	put: ReadonlySet<number>,
	warnings: string[],
): Critique | undefined {
	const at = `critiques[${index}]`;
	if (!isRecord(entry)) {
		warnings.push(`${at} is not an object, so it was dropped.`);
		return undefined;
	}

	const findingId = entry.findingId;
	if (typeof findingId !== "number" || !Number.isInteger(findingId)) {
		warnings.push(`${at} names no finding, so it was dropped.`);
		return undefined;
	}
	if (!put.has(findingId)) {
		// A critic inventing an id would attach an opinion to some
		// other finding's number, which is worse than losing it.
		warnings.push(
			`${at} takes a position on finding ${findingId}, which was not among the findings put up for challenge, so it was dropped.`,
		);
		return undefined;
	}

	const position = text(entry.position);
	if (position === undefined || !POSITIONS.includes(position)) {
		warnings.push(
			`${at} takes the position "${position ?? "nothing"}", which is not one of ${POSITIONS.join(", ")}, so it was dropped.`,
		);
		return undefined;
	}

	const rationale = text(entry.rationale);
	if (rationale === undefined) {
		// A position with no argument cannot be weighed against the
		// finding it disputes, so it is worth less than silence.
		warnings.push(
			`${at} gives no rationale, and a bare vote cannot be weighed against the finding it disputes, so it was dropped.`,
		);
		return undefined;
	}

	return {
		findingId,
		participantId,
		position: position as Position,
		rationale,
	};
}

/** The JSON object in an answer, wherever it is. */
function findJson(text: string): Record<string, unknown> | undefined {
	const whole = parseObject(text);
	if (whole !== undefined) return whole;
	for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
		const fenced = parseObject(match[1] ?? "");
		if (fenced !== undefined) return fenced;
	}
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first === -1 || last <= first) return undefined;
	return parseObject(text.slice(first, last + 1));
}

/** One JSON object, or nothing. */
function parseObject(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	try {
		const held: unknown = JSON.parse(trimmed);
		return isRecord(held) ? held : undefined;
	} catch {
		// Not JSON. Every caller here is guessing at where the JSON
		// might be, so failing is the expected outcome rather than an
		// error worth reporting.
		return undefined;
	}
}

/** A non-empty trimmed string, or nothing. */
function text(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/** A plain object, as against an array or a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
