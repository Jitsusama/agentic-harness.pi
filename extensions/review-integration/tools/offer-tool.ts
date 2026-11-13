/**
 * The `review_offer` tool as pi sees it: its schema, its words and how
 * its call and answer read. What a call does is in `offer.ts`,
 * loaded on the tool's first call, so a session that never calls it
 * never loads it.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadOnce } from "../../../lib/internal/single-flight.ts";
import { sectionParameters, stackSections } from "./sections.ts";
import type { Answer } from "./shared.ts";
import { renderAnswer, renderInvocation } from "./view.ts";

const offerModule = loadOnce(() => import("./offer.ts"));

/** What `review_offer` takes. */
const OFFER_PARAMETERS = Type.Object({
	// An enum rather than a union of literals: the same choices, said in
	// a third of the characters every session sends every turn.
	action: StringEnum(
		[
			"propose",
			"propose-stack",
			"edit",
			"ready",
			"unready",
			"close",
			"reopen",
			"merge",
			"reviewers",
			"rerun",
			"retarget-stack",
		] as const,
		{
			description:
				"What to do. propose: put a branch up as a change; propose-stack: several, each on the one before. edit: its title, body or base. ready, or unready back to a draft. reviewers: ask people to look. close, reopen, merge. rerun: CI again. retarget-stack: after a local restack, point each change at the branch it now sits on.",
		},
	),
	change: Type.Optional(
		Type.String({
			description: "The hosted change. Omit to act on the attached change.",
		}),
	),
	repo: Type.Optional(
		Type.String({
			description:
				"Checkout path, for propose; for merge, where the repo's merge gate runs.",
		}),
	),
	base: Type.Optional(
		Type.String({
			description:
				"For propose: what it merges into, defaulting to the repo's trunk. For edit: retarget.",
		}),
	),
	head: Type.Optional(
		Type.String({
			description:
				"For propose: the branch holding the work, defaulting to the one checked out.",
		}),
	),
	heads: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"For propose-stack: the branches in dependency order, root first. Each is proposed onto the one before it, the first onto base.",
		}),
	),
	bodies: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"For propose-stack: one body per branch, in the order of heads, when not given as sections. Give one for every branch, or none.",
		}),
	),
	sections: Type.Optional(
		Type.Array(Type.Object(stackSections()), {
			description:
				"For propose-stack: each branch's four sections, in the order of heads, held to the same contract as propose's. Preferred over bodies.",
		}),
	),
	title: Type.Optional(
		Type.String({
			description:
				"For propose and edit: the title. On propose it defaults to the last commit's subject.",
		}),
	),
	...sectionParameters(),
	body: Type.Optional(
		Type.String({
			description:
				"For propose and edit: the whole description, when not given as the four sections, which are preferred. Held to the same format.",
		}),
	),
	draft: Type.Optional(
		Type.Boolean({
			description:
				"For propose: whether it opens as a draft. Required for propose, since the backends default opposite ways.",
		}),
	),
	comment: Type.Optional(
		Type.String({ description: "For close: why, said on the change." }),
	),
	which: Type.Optional(
		Type.String({
			description:
				"For rerun: one pipeline, as the backend names it. Omit to rerun everything on the head commit.",
		}),
	),
	method: Type.Optional(
		Type.String({
			description:
				"For merge: the strategy, in the provider's vocabulary. Omit to let the repo's own policy decide.",
		}),
	),
	expectedHead: Type.Optional(
		Type.String({
			description:
				"For merge: refuse unless the head is still this commit. The only guard against merging work nobody saw.",
		}),
	),
	person: Type.Optional(
		Type.String({
			description:
				"For merge: what the change means to the session's person, in one line, kept in the landing their launcher shows, e.g. what to try. Say it only where a check supports it.",
		}),
	),
	reviewers: Type.Optional(
		Type.Array(Type.String(), {
			description: "For reviewers: who to ask.",
		}),
	),
	labels: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"For propose and edit: labels to add; an edit keeps the others unless labelMode is set.",
		}),
	),
	labelMode: Type.Optional(
		StringEnum(["add", "set"] as const, {
			description:
				"For edit: add (the default), or set to replace the labels already there.",
		}),
	),
	unlabels: Type.Optional(
		Type.Array(Type.String(), {
			description: "For edit: labels to take off the change.",
		}),
	),
	assignees: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"For propose and edit: who to assign, as the backend names people (logins on GitHub, emails on some). Added, like labels.",
		}),
	),
	unassignees: Type.Optional(
		Type.Array(Type.String(), {
			description: "For edit: who to unassign.",
		}),
	),
	clear: Type.Optional(
		Type.Array(Type.String(), {
			description: "For edit: fields to empty, e.g. body, labels, assignees.",
		}),
	),
});

/** Register the `review_offer` tool. */
export function registerOfferTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review_offer",
		label: "Review Offer",
		description:
			"Put work up for review and move it along: propose a change from a branch, edit it, mark it ready or draft, ask reviewers, close, reopen and merge it. Reading a change is review_see. This is how a pull request is opened on any host, also when asked to cut, raise or submit one: `gh pr create` reaches GitHub only, and elsewhere opens a change on a mirror nothing reads.",
		promptSnippet:
			"Put work up for review: propose, edit, ready, draft, reviewers, close, reopen, merge.",
		promptGuidelines: [
			"Say whether a new change is a draft. It is required, because the backends disagree about what silence means and the same call otherwise produces a live change on one and an invisible one on the other.",
			"Proposing takes the head, base, title and body from the checkout when you do not name them, and the gate names everything it took. Read that line back rather than approving past it.",
			"When an action is refused, pass on what it says to do instead rather than reporting a generic failure. The refusal names the door that is open.",
			"Never retarget, ready or draft a change that is queued to merge without saying what that costs: on a queue-backed backend it ejects the change and everything batched with it.",
		],
		parameters: OFFER_PARAMETERS,

		renderCall(args, theme, context) {
			const params = args as { action?: string; change?: string };
			return renderInvocation(
				theme,
				"review_offer",
				params.action,
				params.change,
				context?.lastComponent,
			);
		},

		renderResult(result, options, theme, context) {
			return renderAnswer(result, theme, options, context?.lastComponent);
		},

		async execute(_id, params, _signal, _onUpdate, ctx): Promise<Answer> {
			const { runOffer } = await offerModule();
			return runOffer(pi, params, ctx);
		},
	});
}
