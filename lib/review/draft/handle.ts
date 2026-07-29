/**
 * A draft you can hold.
 *
 * The pure layer underneath is the composable one: plain state
 * and functions that return new state. This is the ergonomic
 * one, for the common case of a person working through a review
 * over an afternoon. It persists after every change, so nothing
 * is lost to a crash, and it prunes itself after publishing, so
 * a retry sends what failed and not what already landed.
 */

import type { Anchor } from "../anchor.js";
import type { ReviewTarget } from "../change.js";
import type { Message, Reaction, Thread, Verdict } from "../conversation.js";
import type { ReviewProvider } from "../provider.js";
import type { PlanContext, PublishPlan } from "./plan.js";
import { compilePlan } from "./plan.js";
import type { PublishOutcome } from "./publish.js";
import { publishPlan } from "./publish.js";
import type { RenderOptions, ReviewDocument } from "./render.js";
import { renderDraft } from "./render.js";
import {
	addFinding,
	addReaction,
	addReply,
	addResolution,
	type DraftState,
	emptyDraft,
	removeItem,
	setVerdict,
} from "./state.js";
import type { DraftStore } from "./store.js";

/** What a draft handle needs to do its job. */
export interface DraftDeps {
	store: DraftStore;
}

/** A live draft, persisted as it changes. */
export interface ReviewDraft {
	readonly id: string;
	/** The draft as it stands. */
	readonly state: DraftState;
	/** Add an anchored remark. Returns its item id. */
	addFinding(finding: { anchor: Anchor; body: string }): Promise<string>;
	/** Reply into an existing thread. Returns its item id. */
	replyTo(thread: Thread, body: string): Promise<string>;
	resolveThread(thread: Thread): Promise<string>;
	react(subject: Message, reaction: Reaction): Promise<string>;
	setVerdict(verdict: Verdict, summary?: string): Promise<void>;
	remove(itemId: string): Promise<void>;
	plan(context: PlanContext): PublishPlan;
	/** Publish, then keep only what did not land. */
	publish(plan: PublishPlan, provider: ReviewProvider): Promise<PublishOutcome>;
	render(options?: RenderOptions): ReviewDocument;
}

/**
 * A short random tail, so two drafts about the same change
 * cannot collide on their file name.
 */
function tail(): string {
	return Math.random().toString(36).slice(2, 6);
}

/**
 * A legible id. It names what the draft is about, because a
 * person looking at the store should be able to tell which
 * draft is which without opening them.
 */
function newDraftId(target: ReviewTarget): string {
	const subject =
		target.kind === "proposal"
			? target.change.id
			: target.kind === "range"
				? target.head
				: (target.refs.at(-1) ?? "stack");
	const slug = subject.replace(/[^A-Za-z0-9._-]/g, "-");
	return `${target.kind}-${slug}-${tail()}`;
}

/** Wrap a state in a handle that persists every change. */
function handleFor(initial: DraftState, deps: DraftDeps): ReviewDraft {
	let state = initial;

	async function commit(next: DraftState): Promise<void> {
		state = next;
		await deps.store.save(state);
	}

	/** Apply an operation that appends one item, and name it. */
	async function append(
		apply: (current: DraftState) => DraftState,
	): Promise<string> {
		await commit(apply(state));
		const added = state.items.at(-1);
		return added ? added.id : "";
	}

	return {
		get id() {
			return state.id;
		},
		get state() {
			return state;
		},
		addFinding: (finding) => append((current) => addFinding(current, finding)),
		replyTo: (thread, body) =>
			append((current) => addReply(current, thread, body)),
		resolveThread: (thread) =>
			append((current) => addResolution(current, thread)),
		react: (subject, reaction) =>
			append((current) => addReaction(current, subject, reaction)),

		async setVerdict(verdict, summary) {
			await commit(setVerdict(state, verdict, summary));
		},

		async remove(itemId) {
			await commit(removeItem(state, itemId));
		},

		plan: (context) => compilePlan(state, context),

		async publish(plan, provider) {
			const outcome = await publishPlan(plan, provider);
			let next = state;
			for (const entry of outcome.outcomes) {
				if (!entry.ok) continue;
				for (const itemId of entry.itemIds) {
					next = removeItem(next, itemId);
				}
				// The verdict rode on the review, so it has landed too.
				const carriedVerdict =
					entry.op.kind === "review" || entry.op.kind === "comment";
				if (carriedVerdict) {
					next = { ...next, verdict: undefined, summary: undefined };
				}
			}
			await commit(next);
			return outcome;
		},

		render: (options) => renderDraft(state, options),
	};
}

/**
 * Open the draft for a target, resuming the one already in
 * flight when there is one. Resuming rather than starting
 * afresh is the behaviour a person expects: coming back to a
 * review should find the review, not a blank page beside it.
 */
export async function openDraft(
	target: ReviewTarget,
	deps: DraftDeps,
): Promise<ReviewDraft> {
	const [existing] = await deps.store.forTarget(target);
	if (existing) {
		const state = await deps.store.load(existing.id);
		if (state) return handleFor(state, deps);
	}
	const fresh = emptyDraft(newDraftId(target), target);
	await deps.store.save(fresh);
	return handleFor(fresh, deps);
}

/** Pick a draft back up by id. */
export async function resumeDraft(
	id: string,
	deps: DraftDeps,
): Promise<ReviewDraft | undefined> {
	const state = await deps.store.load(id);
	return state ? handleFor(state, deps) : undefined;
}
