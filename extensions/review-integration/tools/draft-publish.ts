/**
 * Landing a `review_draft`: planning what publishing would do, then
 * publishing one draft, or every draft across a stack, behind the
 * review-publish gate, and noting where the change stood once it landed.
 *
 * Apart from `draft.ts` because it changes with the gate, the prose
 * held to before anything is sent and what is said about what landed,
 * none of which composing a draft touches.
 */

import type {
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
	type BoundTarget,
	createVisitLog,
	type DiffModel,
	type DraftStore,
	publishAcross,
	type ReviewDraft,
	type ReviewTarget,
	type StackPublishEntry,
} from "../../../lib/core/review/index.ts";
import { GUARDS } from "../../../lib/internal/guardian/guards.ts";
import { count } from "../../../lib/ui/count.ts";
import { reviewEngine, visitDir } from "../engine.ts";
import { confirmBatch } from "../gate.ts";
import {
	GLYPH,
	outcomeNarration,
	planNarration,
	proseComplaint,
} from "../render.ts";
import { publishTabs } from "./publish-gate.ts";
import { type Answer, hostedChange, refuse, say } from "./shared.ts";

/**
 * Plan the draft against its target, and for `publish` send it behind
 * the gate.
 */
export async function planOrPublish(
	bound: BoundTarget | undefined,
	draft: ReviewDraft,
	action: string,
	ctx: ExtensionToolContext,
	signal: AbortSignal | undefined,
): Promise<Answer> {
	// Planning and publishing both need the provider's
	// capabilities, and the diff to judge anchors against.
	if (!bound) {
		return refuse(
			"Planning needs the target's provider, and this draft's target could not be found again. Name the change on this call.",
		);
	}
	const diff = await bound.diffModel().catch(() => undefined);
	const plan = draft.plan({
		capabilities: bound.capabilities,
		...(diff ? { diff } : {}),
	});

	if (action === "plan") {
		return say(planNarration(plan), {
			ok: true,
			ops: plan.ops.length,
			degraded: plan.degraded.length,
			refused: plan.refused.length,
		});
	}

	if (plan.ops.length === 0) {
		return refuse(
			"There is nothing in this draft that can be published. Plan it to see why.",
		);
	}
	// Before the gate, not after: the text about to go on
	// somebody else's change is mostly written by models, and
	// models emit emdashes and curly quotes by default.
	const prose = proseComplaint(plan);
	if (prose) return refuse(prose);

	const destination = `${hostedChange(bound)?.label ?? "this target"} \u00b7 ${bound.provider.id}`;
	const tabs = publishTabs(plan, destination, diff);
	const decision = await confirmBatch(
		ctx,
		"Publish This Review",
		tabs.map((tab) => tab.item),
		GUARDS.reviewPublish.name,
	);
	if (!decision.proceed) {
		return decision.redirect
			? refuse(decision.redirect)
			: say("Left in the draft. Nothing was sent.");
	}

	// A tab is a draft item, not a request: rejecting one drops what
	// it came from and the plan is compiled again without it. That is
	// what makes the gate the last chance to drop a remark, rather
	// than something you run review_draft drop for beforehand and
	// then cannot see what you dropped.
	const dropped = tabs
		.filter((_tab, at) => decision.rejected.includes(at))
		.flatMap((tab) => tab.itemIds);
	let sending = plan;
	if (dropped.length > 0) {
		for (const id of dropped) await draft.remove(id);
		sending = draft.plan({
			capabilities: bound.capabilities,
			...(diff ? { diff } : {}),
		});
		if (sending.ops.length === 0) {
			return say(
				`${GLYPH.refused} everything in the draft was dropped at the gate. Nothing was sent.`,
			);
		}
	}
	// Stopped between operations, it sends nothing more, and what
	// it did not send stays in the draft.
	const outcome = await draft.publish(
		sending,
		bound.provider,
		signal ? { signal } : {},
	);
	// Record where the change stood, so coming back to it later can say
	// whether it has moved. Recorded after publishing rather than
	// before: a review that failed to land is not a review of anything,
	// and claiming otherwise would mark work as seen that nobody said.
	if (outcome.ok) await noteVisit(bound);
	return say(outcomeNarration(outcome), {
		ok: outcome.ok,
		landed: outcome.outcomes.filter((entry) => entry.ok).length,
	});
}

/**
 * Record that a review of this change landed, and where it stood.
 *
 * Quietly. A failure here loses a convenience and must not cost a review that
 * has already been posted: the remarks are on the change either way, and
 * throwing now would report a publish that worked as one that did not.
 */
async function noteVisit(bound: BoundTarget): Promise<void> {
	try {
		const change = hostedChange(bound);
		if (change === undefined) return;
		const proposal = await bound.proposal();
		if (!proposal) return;
		createVisitLog(visitDir()).record(change, {
			at: new Date().toISOString(),
			...(proposal.headCommit === undefined
				? {}
				: { commit: proposal.headCommit }),
		});
	} catch {
		// Nothing to do about it and nothing worth interrupting for. The next
		// visit simply reads as the first one.
	}
}

/**
 * Publish every draft in the stack, in the order the stack applies.
 *
 * A draft is about one change, so a review of a stack is several
 * drafts, and publishing them one at a time by hand loses the only
 * thing worth knowing afterwards: which changes now carry a review.
 *
 * Only changes that actually have a draft are published. A stack of
 * six where two drew remarks should send two reviews, not four empty
 * ones, and an empty review posted to a change nobody had anything to
 * say about is noise on somebody else's notifications.
 */
export async function publishStack(
	pi: ExtensionAPI,
	bound: BoundTarget,
	store: DraftStore,
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	signal: AbortSignal | undefined,
): Promise<Answer> {
	const stack = await bound.stack();
	if (!stack) {
		return refuse(
			`The ${bound.provider.id} provider does not read stacks, so there is no stack to publish across. Publish this one change with publish.`,
		);
	}

	const { engine } = await reviewEngine(pi);
	const entries: StackPublishEntry[] = [];
	const skipped: string[] = [];
	// Kept so the gate can show each remark against the code it points at,
	// using the diff already fetched to plan with rather than a second one.
	const diffs = new Map<string, DiffModel | undefined>();

	for (const node of stack.nodes) {
		if (node.change === undefined) continue;
		const change = node.change.ref;
		const target: ReviewTarget = { kind: "change", change };

		const held = await store.forTarget(target);
		if (held.length === 0) {
			skipped.push(node.ref);
			continue;
		}

		const one = await engine.openDraft(target);
		const at = await engine.bound(change);
		const diff = await at.diffModel().catch(() => undefined);
		const plan = one.plan({
			capabilities: at.capabilities,
			...(diff ? { diff } : {}),
		});
		if (plan.ops.length === 0) {
			skipped.push(node.ref);
			continue;
		}
		// Handed over with its plan, so what lands leaves the draft and
		// publishing the stack again sends only what is left.
		entries.push({ ref: node.ref, change, plan, draft: one });
		diffs.set(node.ref, diff);
	}

	if (entries.length === 0) {
		return refuse(
			"No change in this stack has a draft with anything publishable in it. Plan one to see why.",
		);
	}

	// Every change, before any of them. Publishing across a stack is
	// sequential and keeps what landed, so letting the first two
	// through and refusing the third would leave a review half sent
	// over a habit that is the same in all three.
	for (const entry of entries) {
		const prose = proseComplaint(entry.plan);
		if (prose) return refuse(`${entry.ref}: ${prose}`);
	}

	// Grouped by change: every tab is prefixed with the ref it belongs to,
	// so a stack of three reviews reads as three groups rather than one
	// undifferentiated run of remarks.
	const grouped = entries.flatMap((entry) =>
		publishTabs(
			entry.plan,
			`${entry.change.label} \u00b7 ${bound.provider.id}`,
			diffs.get(entry.ref),
		).map((tab) => ({
			ref: entry.ref,
			tab: {
				...tab,
				item: { ...tab.item, label: `${entry.ref} ${tab.item.label}` },
			},
		})),
	);

	const decision = await confirmBatch(
		ctx,
		`Publish ${count(entries.length, "Review", "Reviews")} Across This Stack`,
		grouped.map((one) => one.tab.item),
		GUARDS.reviewPublish.name,
	);
	if (!decision.proceed) {
		return decision.redirect
			? refuse(decision.redirect)
			: say("Left in the drafts. Nothing was sent.");
	}

	// Rejecting a change's Plan tab drops that whole change from the run.
	// Rejecting one of its other tabs is not honoured here, since the plans
	// were compiled against drafts this function does not hold open.
	const dropped = new Set(
		grouped
			.filter((one, at) => one.tab.summary && decision.rejected.includes(at))
			.map((one) => one.ref),
	);
	const sending = entries.filter((entry) => !dropped.has(entry.ref));
	if (sending.length === 0) {
		return say("Every change was dropped at the gate. Nothing was sent.");
	}

	const outcome = await publishAcross(
		sending,
		bound.provider,
		signal ? { signal } : {},
	);
	return say(
		[
			...outcome.changes.map(
				(one) => `${one.ref}: ${outcomeNarration(one.outcome)}`,
			),
			...(skipped.length === 0
				? []
				: [
						`\nNothing to say about ${skipped.join(", ")}, so nothing was sent there.`,
					]),
			...(outcome.remaining.length === 0
				? []
				: [
						`\nStill unsent: ${outcome.remaining.join(", ")}. Publishing again sends only those, since what landed is kept out of the drafts.`,
					]),
		].join("\n"),
		{
			ok: outcome.ok,
			landed: outcome.landed,
			remaining: outcome.remaining,
			skipped,
		},
	);
}
