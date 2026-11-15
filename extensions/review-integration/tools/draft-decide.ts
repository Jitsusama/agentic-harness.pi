/**
 * `review_draft decide`: settling one finding a round raised into the
 * review, onto the fix queue, or out of it.
 *
 * Apart from `draft.ts` because it changes with what a finding becomes
 * once somebody has judged it, which is a matter for the findings and
 * the decision ledger rather than for composing a draft.
 */

import {
	type BoundTarget,
	createDecisionLedger,
	createFindingStore,
	createFixQueue,
	type ReviewDraft,
} from "../../../lib/core/review/index.ts";
import { decisionDir, findingDir, fixDir } from "../engine.ts";
import { anchorLabel, GLYPH } from "../render.ts";
import { type Answer, refuse, reviewedChange, say } from "./shared.ts";

/**
 * Settle one produced finding into the review, or drop it.
 *
 * This is the seam between what something raised and what you are
 * willing to say. A finding is nobody's business until it is
 * promoted, which is why promoting copies it into the draft as a
 * remark rather than the conversation reading findings directly.
 *
 * Promoting takes the finding's own words unless you supply
 * better ones, because the common case is agreeing with a finding
 * and the uncommon case is agreeing with a qualification.
 */
export async function decideFinding(
	bound: BoundTarget | undefined,
	draft: ReviewDraft,
	params: {
		finding?: number;
		settle?: "promote" | "dismiss" | "fix";
		body?: string;
	},
): Promise<Answer> {
	if (params.finding === undefined || params.settle === undefined) {
		return refuse(
			"Deciding needs the finding's number and what to do with it: promote it into the draft, dismiss it, or queue it to fix.",
		);
	}
	if (!bound) {
		return refuse(
			"This draft's change could not be found again, so its findings cannot be read. Name the change on this call.",
		);
	}
	const change = reviewedChange(bound);
	if (!change) {
		return refuse(
			`A ${bound.target.kind} in ${bound.repo.key} holds no findings, since there is no change to hold them on.`,
		);
	}
	const store = createFindingStore(findingDir());
	const findings = await store.list(change);
	const finding = findings.find((held) => held.id === params.finding);
	if (!finding) {
		return refuse(
			findings.length === 0
				? `Nothing has been raised on ${change.label}, so there is no F${params.finding} to decide.`
				: `There is no F${params.finding} on ${change.label}. Read review_see findings; the listing numbers them.`,
		);
	}

	if (params.settle === "dismiss") {
		// Recorded, or the findings listing reads the same before and
		// after: a dismissal leaves no other trace anywhere.
		await createDecisionLedger(decisionDir()).record(
			change,
			finding.id,
			"dismiss",
			params.body,
		);
		return say(
			`${GLYPH.refused} F${finding.id} dismissed, and left out of the draft.\n   ${finding.subject}`,
			{ ok: true, finding: finding.id, settled: "dismiss" },
		);
	}

	if (params.settle === "fix") {
		// Not into the draft. A finding you agree with on your own change
		// is work rather than a remark, and posting it would be telling
		// yourself something you already know.
		await createFixQueue(fixDir()).queue(
			change,
			finding,
			...(params.body === undefined ? [] : [params.body]),
		);
		await createDecisionLedger(decisionDir()).record(
			change,
			finding.id,
			"fix",
			params.body,
		);
		const tally = await createFixQueue(fixDir()).tally(change);
		return say(
			[
				`${GLYPH.finding} F${finding.id} queued to fix, not to say.`,
				`   ${finding.subject}`,
				`   ${tally.pending} waiting. review_draft fix-next takes the first.`,
			].join("\n"),
			{ ok: true, finding: finding.id, settled: "fix", pending: tally.pending },
		);
	}

	const body = params.body ?? `${finding.subject}\n\n${finding.discussion}`;
	const id = await draft.addFinding({ anchor: finding.anchor, body });
	await createDecisionLedger(decisionDir()).record(
		change,
		finding.id,
		"promote",
		params.body,
	);
	return say(
		`${GLYPH.finding} F${finding.id} promoted into draft ${draft.id} as #${id}, at ${anchorLabel(finding.anchor)}${params.body ? "\n   in your words rather than its own" : ""}`,
		{ ok: true, finding: finding.id, item: id, settled: "promote" },
	);
}
