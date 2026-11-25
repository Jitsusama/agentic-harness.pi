/**
 * `review_offer propose`: putting one branch up as a change, filled in
 * from the checkout, shown at the gate, and with its reviewers asked
 * when the backend can take them.
 *
 * Apart from `offer.ts` because it changes with how a proposal is
 * filled in and when its reviewers go, and apart from a stack's
 * proposal (`offer-stack.ts`), whose titles, bodies and bases come from
 * somewhere else.
 */

import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BoundTarget, Change } from "../../../lib/core/review/index.ts";
import { fillProposal } from "../../../lib/core/review/index.ts";
import { sessionCwd } from "../../../lib/core/session/index.ts";
import { sayDid } from "../../../lib/internal/session/events.ts";
import { sayProposed } from "../../../lib/internal/session/landings.ts";
import { REVIEW_COMMANDS, reviewExec } from "../commands.ts";
import { GLYPH, proposalLine } from "../render.ts";
import { councilFirst } from "../reviewed-first.ts";
import { checkoutFacts } from "./offer-checkout.ts";
import { confirmWrite, missingMethod, proposePanel } from "./offer-gates.ts";
import type { OfferParams } from "./offer-request.ts";
import { type Answer, declined, messageOf, refuse, say } from "./shared.ts";

/** Put a branch up as a change. */
export async function propose(
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	bound: BoundTarget,
	authoring: NonNullable<BoundTarget["provider"]["authoring"]>,
	params: OfferParams,
	bus?: Pick<EventBus, "emit">,
): Promise<Answer> {
	if (params.draft === undefined) {
		// Not defaulted, on purpose, and not guessable from the checkout
		// either. One backend opens a new change ready and another opens
		// it as a draft, so guessing means the same call produces a live
		// change on one and an invisible one on the other, and the caller
		// finds out from a surprised reviewer or from a change nobody ever
		// looked at.
		return refuse(
			"Say whether this opens as a draft. It is not defaulted, because the backends disagree about what silence means: one opens a new change ready and another opens it as a draft.",
		);
	}

	// Everything else the checkout already knows. Guessing is safe here
	// because the gate below shows every guess to a person before
	// anything is sent, which is exactly what a provider inferring the
	// same things could not promise.
	const filled = fillProposal(
		{
			...(params.base === undefined ? {} : { base: params.base }),
			...(params.head === undefined ? {} : { head: params.head }),
			...(params.title === undefined ? {} : { title: params.title }),
			...(params.body === undefined ? {} : { body: params.body }),
		},
		await checkoutFacts(REVIEW_COMMANDS, params.repo ?? sessionCwd(ctx)),
	);
	if ("refusal" in filled) return refuse(filled.refusal);
	const { base, head, title, body, guessed, warnings } = filled.fill;

	// A draft asks nobody to look, unless it names reviewers.
	if (!params.draft || (params.reviewers?.length ?? 0) > 0) {
		const waits = await councilFirst(
			reviewExec,
			{
				repo: bound.repo.key,
				checkout: params.repo ?? sessionCwd(ctx),
				base,
				head,
			},
			"proposed for review",
		);
		if (waits) return refuse(waits);
	}

	const decision = await confirmWrite(
		ctx,
		`Propose ${head} onto ${base}`,
		proposePanel({
			head,
			base,
			repo: bound.repo.key,
			title,
			body,
			draft: params.draft,
			...(params.reviewers?.length ? { reviewers: params.reviewers } : {}),
			...(guessed.length > 0 ? { guessed } : {}),
			...(warnings.length > 0 ? { warnings } : {}),
		}),
	);
	if (!decision.approved) return declined(decision, "Not proposed.");

	// Where the reviewers go depends on when the backend can take them. One
	// that takes them only at creation has to be told now, because after
	// this call there is no moment left; one that takes them any time is
	// asked afterwards, against the change that now exists.
	const atCreation =
		bound.capabilities.authoring?.reviewersAt === "creation" &&
		(params.reviewers?.length ?? 0) > 0;

	const made: Change = await authoring.propose({
		repo: bound.repo,
		base,
		head,
		title,
		body,
		draft: params.draft,
		...(params.labels?.length ? { labels: params.labels } : {}),
		...(params.assignees?.length ? { assignees: params.assignees } : {}),
		...(atCreation && params.reviewers ? { reviewers: params.reviewers } : {}),
	});

	// Otherwise after the change exists, since there is nothing to ask
	// anyone to look at before that. A failure here leaves a real change
	// behind, so it is reported rather than thrown: losing the change
	// because the ask failed would be the worse trade.
	let asking = atCreation
		? `\n   asked ${(params.reviewers ?? []).join(", ")}`
		: "";
	if (params.reviewers?.length && !atCreation) {
		try {
			// Not an optional call. Reporting "asked alice, bob" because the
			// method was absent is the one degradation nobody can detect: it
			// is said in the past tense about something that never happened,
			// and the reviewers are simply never asked.
			if (authoring.requestReviewers === undefined) {
				throw new Error(missingMethod(bound.provider.id, "request reviewers"));
			}
			await authoring.requestReviewers(made.ref, params.reviewers);
			asking = `\n   asked ${params.reviewers.join(", ")}`;
		} catch (error) {
			asking = `\n   ${GLYPH.refused} the change is up, but asking ${params.reviewers.join(", ")} failed: ${messageOf(error)}`;
		}
	}

	sayDid(bus, { kind: "pr", where: bound.repo.key, title: made.title });
	sayProposed(bus, [made.url]);
	return say(`${GLYPH.lands} ${proposalLine(made)}${asking}`, {
		ok: true,
		change: made.ref.label,
		url: made.url,
	});
}
