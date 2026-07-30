/**
 * Weighing what other people asked for against what the change does.
 *
 * A change under review usually arrives with threads already on it,
 * some of them answered by later commits and never marked resolved.
 * Working out which is slow, and getting it wrong is worse than slow:
 * replying "fixed" to a thread nothing addressed reads as a brush-off,
 * and re-fixing something already fixed wastes a round trip.
 *
 * So an audit judges each thread and says why, and that is all it
 * does. It never posts, and it raises no findings: these are other
 * people's words, and turning them into findings would put them into
 * the review as ours. The reply stays a human decision, better
 * informed.
 */

import type { CritiqueDeps } from "./critique.js";
import { type Participant, participantIdentity } from "./identity.js";
import { type AskRun, newRunId, type ParticipantOutcome } from "./run.js";
import { findJson, isRecord, wireText, wireWhole } from "./wire.js";

/**
 * Where an inbound thread stands against the change.
 *
 * `elsewhere` is the one worth naming separately: in a stack, a thread
 * on one change is often answered by a sibling, and reporting that as
 * addressed would send somebody looking in the wrong diff.
 */
export type Standing = "addressed" | "outstanding" | "elsewhere" | "unclear";

/** One judgement about one inbound thread. */
export interface ThreadAudit {
	threadIndex: number;
	participantId: string;
	standing: Standing;
	rationale: string;
	/** Where in the change the auditor saw it, when it says. */
	evidence?: string;
}

/** What came out of one auditor's answer. */
export interface AuditHarvest {
	audits: ThreadAudit[];
	warnings: string[];
}

/** What to audit, and who weighs it. */
export interface AuditRequest {
	auditor: Participant;
	prompt: string;
	seq: number;
	/** The threads put up, by the index a reader cites them as. */
	threadIndices: number[];
}

/** The round, the judgements, and anything worth saying. */
export interface AuditResult {
	run: AskRun;
	audits: ThreadAudit[];
	warnings: string[];
}

/** The standings an auditor may report. */
const STANDINGS: readonly string[] = [
	"addressed",
	"outstanding",
	"elsewhere",
	"unclear",
];

/** Read one auditor's answer, warning about what it dropped. */
export function harvestAudits(
	text: string,
	participantId: string,
	threadIndices: readonly number[],
): AuditHarvest {
	const parsed = findJson(text);
	const held = parsed?.audits;
	if (!Array.isArray(held)) {
		return {
			audits: [],
			warnings: [
				"Nothing in this answer parsed as an audits array, so no judgements could be read from it.",
			],
		};
	}

	const put = new Set(threadIndices);
	const audits: ThreadAudit[] = [];
	const warnings: string[] = [];
	for (const [index, entry] of held.entries()) {
		const one = readAudit(entry, index, participantId, put, warnings);
		if (one !== undefined) audits.push(one);
	}
	return { audits, warnings };
}

/** Put the inbound threads to an auditor and gather its judgements. */
export async function runAudit(
	request: AuditRequest,
	deps: CritiqueDeps,
): Promise<AuditResult> {
	const startedAt = deps.now();
	const id = newRunId("audit", startedAt, request.seq);

	// Nothing to audit means nobody to ask, and holding no
	// participants is how the run says it asked nobody rather than
	// that somebody answered with nothing.
	if (request.threadIndices.length === 0) {
		return {
			run: {
				id,
				round: "audit",
				startedAt: startedAt.toISOString(),
				participants: [],
				outcomes: [],
			},
			audits: [],
			warnings: [],
		};
	}

	// One auditor rather than a roster, so askRoster would be a fan-out
	// of one. It still reports: a lone audit reading a long thread looks
	// just as hung as six reviewers do.
	const progress = deps.progress;
	progress?.start([request.auditor]);
	progress?.started(request.auditor.id);
	const answer = await (async () => {
		try {
			return await deps.ask(request.auditor, request.prompt, (activity) =>
				progress?.activity(request.auditor.id, activity),
			);
		} catch (error) {
			return {
				failure: error instanceof Error ? error.message : String(error),
			};
		}
	})();
	if ("failure" in answer) {
		progress?.failed(request.auditor.id, answer.failure);
	} else {
		progress?.answered(request.auditor.id);
	}
	progress?.finish();

	const warnings: string[] = [];
	const audits: ThreadAudit[] = [];
	const outcome: ParticipantOutcome = (() => {
		if ("failure" in answer) {
			return {
				participantId: request.auditor.id,
				findingIds: [],
				failure: answer.failure,
			};
		}
		const harvest = harvestAudits(
			answer.text,
			request.auditor.id,
			request.threadIndices,
		);
		audits.push(...harvest.audits);
		for (const warning of harvest.warnings) {
			warnings.push(`${request.auditor.id}: ${warning}`);
		}
		return {
			participantId: request.auditor.id,
			// An audit raises no findings, on purpose.
			findingIds: [],
			...(answer.usage === undefined ? {} : { usage: answer.usage }),
		};
	})();

	return {
		run: {
			id,
			round: "audit",
			startedAt: startedAt.toISOString(),
			// Held as a judge: an auditor weighs what exists rather than
			// finding anything, which is the judging role.
			participants: [participantIdentity("judge", request.auditor)],
			outcomes: [outcome],
		},
		audits,
		warnings,
	};
}

/** One judgement, or nothing plus a warning saying why. */
function readAudit(
	entry: unknown,
	index: number,
	participantId: string,
	put: ReadonlySet<number>,
	warnings: string[],
): ThreadAudit | undefined {
	const at = `audits[${index}]`;
	if (!isRecord(entry)) {
		warnings.push(`${at} is not an object, so it was dropped.`);
		return undefined;
	}

	const threadIndex = wireWhole(entry.threadIndex);
	if (threadIndex === undefined) {
		warnings.push(`${at} names no thread, so it was dropped.`);
		return undefined;
	}
	if (!put.has(threadIndex)) {
		warnings.push(
			`${at} judges thread ${threadIndex}, which was not among the threads put up, so it was dropped.`,
		);
		return undefined;
	}

	const standing = wireText(entry.standing);
	if (standing === undefined || !STANDINGS.includes(standing)) {
		warnings.push(
			`${at} reports the standing "${standing ?? "nothing"}", which is not one of ${STANDINGS.join(", ")}, so it was dropped.`,
		);
		return undefined;
	}

	const rationale = wireText(entry.rationale);
	if (rationale === undefined) {
		// An audit exists to inform a reply, and a standing with no
		// argument gives the person replying nothing to say.
		warnings.push(
			`${at} gives no rationale, so it was dropped: a standing with no argument gives whoever replies nothing to say.`,
		);
		return undefined;
	}

	const evidence = wireText(entry.evidence);
	return {
		threadIndex,
		participantId,
		standing: standing as Standing,
		rationale,
		...(evidence === undefined ? {} : { evidence }),
	};
}
