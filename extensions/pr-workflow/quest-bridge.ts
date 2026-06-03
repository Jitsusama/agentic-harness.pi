/**
 * Optional quest-workflow integration for pr-workflow.
 *
 * When quest-workflow is loaded it registers a bridge on
 * globalThis. This module is the thin pr-workflow side:
 * it finds the sidequest the bridge points at and appends
 * a Journey bullet for every review round that completes.
 *
 * Everything here tolerates the bridge being absent. When
 * it isn't registered, every entry point is a silent no-op
 * so pr-workflow works unchanged without quest-workflow.
 */

import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import {
	buildAliasIndex,
	lookupAliasDetail,
} from "../../lib/internal/quest/alias-index.js";
import { discoverQuests } from "../../lib/internal/quest/discovery.js";
import {
	type AppendRoundResult,
	appendPrReviewRound,
	type ReviewDocCritique,
	type ReviewDocFinding,
} from "../../lib/internal/quest/pr-review-doc.js";
import { getQuestPrBridge } from "../../lib/quest/pr-bridge.js";
import type { CritiqueRun } from "./critique.js";
import type { Finding } from "./findings.js";
import type { JudgeRun } from "./judge.js";

/**
 * Locate the sidequest for a PR via the alias index.
 *
 * Refuses to guess when the alias is registered on more
 * than one quest. The caller treats `undefined` as "no
 * sidequest" either way; the silent-collision case would
 * be a worse outcome than no-op.
 */
function findSidequest(
	reference: PRReference,
): { sidequestId: string; sidequestDir: string } | undefined {
	const bridge = getQuestPrBridge();
	if (!bridge) return undefined;
	const aliasValue = `${reference.owner}/${reference.repo}#${reference.number}`;
	const { index } = discoverQuests(bridge.questsRoot());
	const aliasIdx = buildAliasIndex(index);
	const lookup = lookupAliasDetail(aliasIdx, {
		type: "github-pr",
		value: aliasValue,
	});
	if (lookup.kind === "miss") return undefined;
	if (lookup.kind === "collision") {
		console.warn(
			`[pr-workflow] alias github-pr:${aliasValue} is registered on ${lookup.questIds.length} quests (${lookup.questIds.join(", ")}); refusing to pick one.`,
		);
		return undefined;
	}
	const entry = index.quests.get(lookup.questId);
	if (!entry) return undefined;
	return { sidequestId: lookup.questId, sidequestDir: entry.dir };
}

/**
 * Walk the alias index for the loaded PR and append a
 * Journey bullet to the matching sidequest. No-op when the
 * bridge is absent or no sidequest matches.
 */
export function logQuestJourneyForPr(
	reference: PRReference,
	prose: string,
): void {
	const bridge = getQuestPrBridge();
	if (!bridge) return;
	const sidequest = findSidequest(reference);
	if (!sidequest) return;
	bridge.logJourney(sidequest.sidequestDir, prose);
}

/** Map pr-workflow's `Finding` into the doc serializer's shape. */
function toDocFinding(finding: Finding): ReviewDocFinding {
	const doc: ReviewDocFinding = {
		id: finding.id,
		label: finding.label,
		subject: finding.subject,
		discussion: finding.discussion,
		location: finding.location,
	};
	if (finding.severity) doc.severity = finding.severity;
	if (finding.agreement) {
		doc.agreement = {
			raisedBy: finding.agreement.raisedBy,
			sourceFindingIds: finding.agreement.sourceFindingIds,
		};
	}
	return doc;
}

/** Flatten a critique run into per-finding entries. */
function toDocCritiques(run: CritiqueRun | null): ReviewDocCritique[] {
	if (!run) return [];
	const out: ReviewDocCritique[] = [];
	for (const reviewer of run.reviewerOutputs) {
		for (const entry of reviewer.critiques) {
			out.push({
				findingId: entry.findingId,
				reviewerId: entry.reviewerId,
				position: entry.position,
				rationale: entry.rationale,
			});
		}
	}
	return out;
}

/** Input for `recordReviewRound`. */
export interface RecordReviewRoundInput {
	readonly councilReviewerIds: string[];
	readonly rawFindingsCount: number;
	readonly judgeRun: JudgeRun;
	readonly critiqueRun?: CritiqueRun | null;
}

/**
 * Persist the just-completed judge round to the PR
 * sidequest's research doc, scaffolding the doc on the
 * first round. Returns the append result so the caller
 * can surface the doc path / round number in its tool
 * response. No-op (returns undefined) when the bridge is
 * absent or no sidequest matches.
 */
export function recordReviewRound(
	reference: PRReference,
	input: RecordReviewRoundInput,
): AppendRoundResult | undefined {
	const sidequest = findSidequest(reference);
	if (!sidequest) return undefined;
	const result = appendPrReviewRound({
		sidequestDir: sidequest.sidequestDir,
		sidequestId: sidequest.sidequestId,
		prSlug: `${reference.owner}/${reference.repo}#${reference.number}`,
		date: "",
		councilReviewerIds: input.councilReviewerIds,
		rawFindingsCount: input.rawFindingsCount,
		judgeFindings: input.judgeRun.consolidatedFindings.map(toDocFinding),
		judgeSelfSignal: input.judgeRun.selfSignal,
		critiques: toDocCritiques(input.critiqueRun ?? null),
	});
	return result;
}
