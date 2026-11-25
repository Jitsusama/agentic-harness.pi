/**
 * The `review_offer` tool: putting work up, and moving it along.
 *
 * The other four tools read a change or talk about one. This is the
 * one that makes a change exist, and it is what closes the gap between
 * having a branch and having something people can review.
 *
 * Every action asks the provider first, through `offerable`, before it
 * asks the network. Reviewing degrades gracefully and authoring does
 * not: a retarget that means something different here moves changes
 * nobody asked to move, and touching a change that sits in a merge
 * queue ejects it along with everything batched with it. When the
 * answer is no, the refusal carries what to do instead, because a
 * caller told only that something is unsupported has to go and read a
 * CLI's help to find the door that is open.
 *
 * What a call does, loaded on its first call; the registration is
 * `offer-tool.ts`. This file checks a call and takes it to its action.
 * Proposing is in `offer-propose.ts`, a stack's actions in
 * `offer-stack.ts`, editing in `offer-edit.ts`, merging in
 * `offer-merge.ts`, what the checkout says in `offer-checkout.ts`, the
 * gates in `offer-gates.ts`, and what a call passes in
 * `offer-request.ts`.
 */

import { resolve } from "node:path";
import type {
	EventBus,
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import type {
	AuthoringIntent,
	BoundTarget,
} from "../../../lib/core/review/index.ts";
import {
	misnamedPeople,
	offerable,
	proposalComplaint,
} from "../../../lib/core/review/index.ts";
import { PR_SHAPE } from "../../../lib/core/sections/sanctioned.ts";
import { usesDepth } from "../../../lib/core/sections/shape.ts";
import { sessionCwd, sessionKeyOf } from "../../../lib/core/session/index.ts";
import { sayClosed } from "../../../lib/internal/session/landings.ts";
import { REVIEW_COMMANDS, reviewExec } from "../commands.ts";
import { gateRunner } from "../merge-gate.ts";
import { GLYPH } from "../render.ts";
import { councilFirst } from "../reviewed-first.ts";
import { hostedSize } from "./change-size.ts";
import {
	proposalSize,
	proposingElsewhere,
	withCheckoutEnds,
} from "./offer-checkout.ts";
import { edit } from "./offer-edit.ts";
import {
	cautioned,
	closePanel,
	confirmWrite,
	missingMethod,
} from "./offer-gates.ts";
import { merge, reviewSection } from "./offer-merge.ts";
import { propose } from "./offer-propose.ts";
import {
	draftOf,
	inTitleCase,
	type OfferParams,
	resubmitted,
	sectionsGiven,
} from "./offer-request.ts";
import { proposeStack, retargetStack } from "./offer-stack.ts";
import {
	keepRefusedDraft,
	RESUBMIT_ONLY_CHANGES,
	sayRefusal,
} from "./resubmit.ts";
import { revised, type SectionFields, sectionsOf } from "./sections.ts";
import {
	type Answer,
	boundFor,
	declined,
	hostedChange,
	refuse,
	refuseFailure,
	say,
} from "./shared.ts";

/**
 * Actions whose intent a merge queue objects to.
 *
 * Named here so the queue is only fetched when the answer could change
 * what happens. Proposing has no change to be queued yet, and merging is
 * what a queue is for.
 */
const ASKS_THE_QUEUE: ReadonlySet<OfferParams["action"]> = new Set([
	"edit",
	"ready",
	"unready",
]);

/**
 * Which authoring intent an action amounts to.
 *
 * `edit` is the interesting one and is decided per call by
 * {@link intentFor} rather than here, because an edit is only a retarget
 * when it moves the base. Mapping every edit to `retarget` made a title
 * change ask Meteorite whether it could retarget, which it answers by
 * explaining that retargeting is a stack operation there: a true
 * sentence, and no reason at all to refuse a new title.
 */
const INTENT: Record<OfferParams["action"], AuthoringIntent["kind"]> = {
	propose: "propose",
	"propose-stack": "propose-stack",
	edit: "retarget",
	// Retargeting a stack is a retarget, whichever route carries it out,
	// so it meets the same queue gate as moving one change's base. That
	// is the point of mapping it here rather than exempting it: a stack
	// with an enqueued change in it ejects that change too.
	"retarget-stack": "retarget",
	ready: "set-draft",
	unready: "set-draft",
	close: "close",
	reopen: "reopen",
	merge: "merge",
	reviewers: "request-reviewers",
	rerun: "rerun-checks",
};

/**
 * What this call actually amounts to, which for an edit depends on what
 * it is editing.
 *
 * Only a base change is a retarget. Everything else an edit can touch,
 * meaning a title, a body, labels or assignees, is available wherever
 * proposing is, so asking about retargeting would refuse work that was
 * never in question.
 */
function intentFor(params: OfferParams): AuthoringIntent["kind"] {
	if (params.action !== "edit") return INTENT[params.action];
	const movesBase =
		params.base !== undefined || (params.clear ?? []).includes("base");
	return movesBase ? "retarget" : "edit";
}

/** Do what a `review_offer` call asks, once the tool is first called. */
export async function runOffer(
	pi: ExtensionAPI,
	params: OfferParams,
	ctx: ExtensionToolContext,
): Promise<Answer> {
	// Held outside the try so a failure can say which provider was
	// asked. Most of what fails here fails against a backend, and the
	// backend's own message is about its own request.
	let bound: BoundTarget | undefined;
	try {
		// Before the bind, because none of it needs a provider and a
		// refusal should leave nothing behind. Binding remembers what it
		// resolved for the rest of the session, so a call that was never
		// going to be sent has no business recording a decision, and a
		// convention refusal now costs no backend round trip either.
		//
		// The four sections become the body here, so everything after
		// this sees one description however it arrived. An edit naming
		// only some sections has to read the change first, so its body is
		// checked once the change is known.
		let revising: SectionFields | undefined;
		let deferredBody = false;
		if (params.action === "propose") {
			params = resubmitted(params, draftOf(ctx, params));
		}
		if (params.title !== undefined) {
			params = { ...params, title: inTitleCase(params.title) };
		}
		if (params.action === "propose" || params.action === "edit") {
			const sections = sectionsOf(params.action, params);
			if (sections.kind === "refuse") return refuse(sections.reason);
			const asSections =
				sections.kind === "body" ? sectionsGiven(params) : undefined;
			if (sections.kind === "body") params = { ...params, body: sections.body };
			if (sections.kind === "revise") revising = sections.fields;
			// A body that goes deeper is held to the room its change's size
			// gives it. A proposal's size is the checkout's, read here; an
			// edit's is the backend's, so its body waits for the change.
			const deep =
				params.body !== undefined && usesDepth(params.body, PR_SHAPE);
			deferredBody = deep && params.action === "edit";
			const size =
				deep && params.action === "propose"
					? await proposalSize(params, sessionCwd(ctx))
					: undefined;
			const complaint = proposalComplaint(
				params.title,
				deferredBody ? undefined : params.body,
				size,
			);
			if (complaint) {
				const said = sayRefusal(
					sessionKeyOf(ctx),
					complaint,
					params.title,
					params.body,
				);
				// A refused proposal's sections are kept, so its resubmission
				// need send only what changes.
				if (params.action === "propose" && asSections !== undefined) {
					keepRefusedDraft(draftOf(ctx, params), params.title, asSections);
					return refuse(`${said}\n\n${RESUBMIT_ONLY_CHANGES}`);
				}
				return refuse(said);
			}
		}

		bound = await boundFor(
			pi,
			params.action === "propose"
				? await withCheckoutEnds(params, sessionCwd(ctx))
				: params,
			sessionCwd(ctx),
		);
		const authoring = bound.provider.authoring;

		// Proposing takes its repo from the checkout whenever the call
		// names a base and a head, since `boundFor` prefers that over the
		// attachment, and from the attachment only when it names neither.
		// The checkout winning is right: the branch being proposed exists
		// only in the repo it was committed in.
		//
		// This is why the attachment path needs the refusal below.
		// Reading a change on one backend and then proposing from a
		// checkout of another would offer the local branch to the attached
		// repo, and nothing said so: the gate named a head and a base and
		// never a repo, so the only clue was a base branch that looked
		// ordinary.
		//
		// Note what the checkout resolves to now. `fromLocal` mints a
		// `local:` key for the target and hands the probe to every
		// provider, so a provider that claims the checkout answers with
		// its own hosted key and that is what gets bound. It used to be
		// read back as the `local:` key on every call after the first,
		// which is what sent a hosted repo to plain git and lost the
		// authoring facet with it.
		//
		// Refused rather than quietly corrected, since the right answer
		// is not available here to substitute.
		if (params.action === "propose" || params.action === "propose-stack") {
			const elsewhere = await proposingElsewhere(
				REVIEW_COMMANDS,
				params.repo ?? sessionCwd(ctx),
				bound,
			);
			if (elsewhere) return refuse(elsewhere);
		}

		// Where the change stands with a merge queue, read from the
		// provider rather than taken on the caller's word. This is the
		// line that was missing: the refusal below has always been able
		// to fire on a queued change, and nothing ever told it one was.
		const intent = intentFor(params);

		const queue =
			ASKS_THE_QUEUE.has(params.action) &&
			bound.capabilities.authoring?.refusesWhileEnqueued &&
			bound.target.kind === "change"
				? (await bound.provider.changes?.fetch(bound.target.change))?.queue
				: undefined;

		// Asked before anything is sent, and asked of this repo
		// rather than of the provider in general, since a provider
		// can be able to do something everywhere but here.
		const allowed = offerable(
			{
				kind: intent,
				...(params.action === "propose" && params.reviewers?.length
					? { withReviewers: true }
					: {}),
				...(queue ? { queue } : {}),
			},
			bound.capabilities.authoring,
			bound.provider.id,
		);
		if (!allowed.ok) {
			return refuse(
				allowed.instead
					? `${allowed.reason}\n\n${allowed.instead}`
					: allowed.reason,
			);
		}

		// Permitted, but with something the approver needs to know: a
		// backend that has a merge queue and could not say where this
		// change sits in it. Carried to the gate rather than logged,
		// because the gate is the only place a person is looking.
		const caution = allowed.caution;
		if (!authoring) {
			return refuse(
				`The ${bound.provider.id} provider says it can author changes but exposes no way to, which is a bug in that provider rather than in what you asked.`,
			);
		}

		// The title and body were checked before the bind: whatever text
		// is about to become a proposal is held to the same conventions
		// the guardian enforces on `gh pr create`, or authoring through a
		// tool is a way around every rule the shell path cannot be talked
		// past.
		//
		// Named people are held to the form this backend names people
		// in, here rather than in each action, since assignees and
		// reviewers reach three of them. Before anything is sent: a
		// backend that refuses an assignee refuses it on the request
		// that creates the change, so finding out later means finding
		// out with the change already up.
		const misnamed = peopleComplaint(bound, params);
		if (misnamed) return refuse(misnamed);
		// A stack's titles come from commit subjects rather than from
		// the caller, and those are already held to the standard by the
		// commit guardian, so there is nothing here to check ahead of
		// the gate that shows them.

		if (params.action === "propose") {
			return propose(ctx, bound, authoring, params, pi.events);
		}

		if (params.action === "propose-stack") {
			return proposeStack(ctx, bound, authoring, params, pi.events);
		}

		const change = hostedChange(bound);
		if (!change) {
			return refuse(
				"Nothing hosts this target, so there is no change to act on. Propose it first.",
			);
		}

		switch (params.action) {
			case "edit": {
				if (revising === undefined && !deferredBody) {
					return edit(ctx, change, authoring, params, caution);
				}
				const current = await bound.provider.changes?.fetch(change);
				if (revising === undefined) {
					const size =
						current === undefined
							? {
									unknown: `the ${bound.provider.id} provider cannot read this change`,
								}
							: await hostedSize(
									current,
									bound.provider.id,
									bound.provider.changes,
								);
					const complaint = proposalComplaint(undefined, params.body, size);
					if (complaint) {
						return refuse(
							sayRefusal(sessionKeyOf(ctx), complaint, undefined, params.body),
						);
					}
					return edit(ctx, change, authoring, params, caution);
				}
				if (current === undefined) {
					return refuse(
						`The ${bound.provider.id} provider cannot read this change's description, so there is nothing to keep the other sections from. Give all four sections to replace it.`,
					);
				}
				const next = revised(current.body, revising);
				if ("refusal" in next) return refuse(next.refusal);
				const complaint = proposalComplaint(
					undefined,
					next.body,
					usesDepth(next.body, PR_SHAPE)
						? await hostedSize(
								current,
								bound.provider.id,
								bound.provider.changes,
							)
						: undefined,
				);
				if (complaint) {
					return refuse(
						sayRefusal(sessionKeyOf(ctx), complaint, undefined, next.body),
					);
				}
				return edit(
					ctx,
					change,
					authoring,
					{ ...params, body: next.body },
					caution,
				);
			}
			case "ready":
			case "unready": {
				const wanted = params.action === "unready";
				if (!wanted) {
					const waits = await heldForCouncil(
						bound,
						change,
						params,
						ctx,
						"marked ready",
					);
					if (waits) return refuse(waits);
				}
				const decision = await confirmWrite(
					ctx,
					`Move ${change.label} to ${wanted ? "Draft" : "Ready"}`,
					cautioned(`${GLYPH.target} ${change.label}`, caution),
				);
				if (!decision.approved) return declined(decision, "Left as it was.");
				if (authoring.setDraft === undefined) {
					return refuse(
						missingMethod(
							bound.provider.id,
							"move a change between draft and ready",
						),
					);
				}
				await authoring.setDraft(change, wanted);
				return say(
					`${GLYPH.lands} ${change.label} is now ${wanted ? "a draft" : "ready for review"}.`,
				);
			}
			case "close": {
				const decision = await confirmWrite(
					ctx,
					`Close ${change.label}`,
					closePanel({
						label: change.label,
						...(params.comment ? { comment: params.comment } : {}),
					}),
				);
				if (!decision.approved) return declined(decision, "Left open.");
				await authoring.close(
					change,
					...(params.comment === undefined ? [] : [params.comment]),
				);
				await sayChangeClosed(pi.events, bound);
				return say(`${GLYPH.lands} ${change.label} closed.`);
			}
			case "reopen": {
				const decision = await confirmWrite(
					ctx,
					`Reopen ${change.label}`,
					`${GLYPH.target} ${change.label}`,
				);
				if (!decision.approved) return declined(decision, "Left closed.");
				if (authoring.reopen === undefined) {
					return refuse(
						missingMethod(bound.provider.id, "reopen a closed change"),
					);
				}
				await authoring.reopen(change);
				return say(`${GLYPH.lands} ${change.label} reopened.`);
			}
			case "rerun": {
				const decision = await confirmWrite(
					ctx,
					`Run CI Again on ${change.label}`,
					[
						`${GLYPH.target} ${change.label}`,
						params.which
							? `\nJust ${params.which}.`
							: "\nEverything on its head commit, which on a large repo is not free.",
					].join("\n"),
				);
				if (!decision.approved) return declined(decision, "Left alone.");
				if (authoring.rerun === undefined) {
					return refuse(
						missingMethod(bound.provider.id, "ask CI to run again"),
					);
				}
				const outcome = await authoring.rerun(
					change,
					...(params.which === undefined ? [] : [params.which]),
				);
				// Declined is reported as plainly as started. A backend that
				// understood and said no is not a failure, and narrating it
				// as success is how somebody ends up waiting on a build that
				// was never queued.
				return outcome.kind === "started"
					? say(
							`${GLYPH.queued} CI asked to run again on ${change.label}${outcome.which ? `, ${outcome.which} only` : ""}. Results arrive later; read them with review_see checks.`,
						)
					: refuse(
							`${bound.provider.id} declined to rerun CI on ${change.label}: ${outcome.reason}.`,
						);
			}
			case "retarget-stack":
				return retargetStack(ctx, bound, change, authoring);
			case "merge":
				return merge(ctx, bound, change, authoring, params, pi.events, {
					...(await reviewSection()),
					// A relative repo is the session's, not the host process's,
					// which in a shared host is some other folder.
					cwd: resolve(
						sessionCwd(ctx),
						params.repo ?? change.repo.localPath ?? ".",
					),
					run: gateRunner(),
				});
			case "reviewers": {
				const waits = await heldForCouncil(
					bound,
					change,
					params,
					ctx,
					"put to reviewers",
				);
				if (waits) return refuse(waits);
				return reviewers(ctx, change, authoring, params);
			}
		}
	} catch (error) {
		return refuseFailure(error, bound);
	}
}

/**
 * Whether the people named are named the way this backend names people.
 *
 * Asked before anything is sent. A backend that refuses an assignee does
 * it on the request that creates the change, so finding out afterwards
 * means finding out with the change already up.
 */
function peopleComplaint(
	bound: BoundTarget,
	params: OfferParams,
): string | undefined {
	const form = bound.capabilities.authoring?.identifies ?? "unknown";
	const named = [...(params.assignees ?? []), ...(params.reviewers ?? [])];
	const complaint = misnamedPeople(named, form);
	return complaint === undefined
		? undefined
		: `${complaint} Name them the way ${bound.provider.id} does.`;
}

/**
 * Why a hosted change must wait for a council of ours before `doing`,
 * read from the change's base and head as its backend reports them.
 */
async function heldForCouncil(
	bound: BoundTarget,
	change: NonNullable<ReturnType<typeof hostedChange>>,
	params: OfferParams,
	ctx: ExtensionToolContext,
	doing: string,
): Promise<string | undefined> {
	// Guessing the range would judge whatever the session stands on,
	// which isn't the change.
	const changes = bound.provider.changes;
	if (changes === undefined) {
		return `${change.label} isn't ${doing}: ${bound.provider.id} can't say what its commits are, so whether our own council read it can't be told (Joel's rule: our own review before anyone else's).`;
	}
	const hosted = await changes.fetch(change);
	return councilFirst(
		reviewExec,
		{
			repo: bound.repo.key,
			checkout: params.repo ?? change.repo.localPath ?? sessionCwd(ctx),
			base: hosted.base,
			head: hosted.head,
			...(hosted.headCommit ? { headCommit: hosted.headCommit } : {}),
		},
		doing,
	);
}

/**
 * Say on the bus that a change was closed, by its web page, so a look
 * the person was pointed at stops waiting on it.
 */
async function sayChangeClosed(
	bus: EventBus,
	bound: BoundTarget,
): Promise<void> {
	try {
		const url = (await bound.proposal())?.url;
		if (url) sayClosed(bus, url);
	} catch {
		// A change that can't be read now is closed all the same; a look at
		// it waits for the person to clear it.
	}
}

/** Ask people to look. */
async function reviewers(
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	change: NonNullable<ReturnType<typeof hostedChange>>,
	authoring: NonNullable<BoundTarget["provider"]["authoring"]>,
	params: OfferParams,
): Promise<Answer> {
	const asking = params.reviewers ?? [];
	if (asking.length === 0) {
		return refuse("Asking for reviewers needs somebody to ask.");
	}

	const decision = await confirmWrite(
		ctx,
		`Ask ${asking.join(", ")} to Review ${change.label}`,
		`${GLYPH.target} ${change.label}`,
	);
	if (!decision.approved) return declined(decision, "Nobody was asked.");

	// Said in the past tense, so it has to be true. An optional call here
	// reported that people had been asked whenever the method was missing,
	// which is a degradation with no symptom: the change simply sits there
	// with nobody looking at it. The capability gate refuses first for every
	// provider that ships today, and this is what happens when one declares
	// the capability without the method behind it.
	if (authoring.requestReviewers === undefined) {
		return refuse(
			`${missingMethod(change.provider, "request reviewers")} Ask them directly instead.`,
		);
	}

	await authoring.requestReviewers(change, asking);
	return say(`${GLYPH.lands} asked ${asking.join(", ")}.`);
}
