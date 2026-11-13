/**
 * The `review` tool as pi sees it: its schema, its words and how
 * its call and answer read. What a call does is in `read.ts`,
 * loaded on the tool's first call, so a session that never calls it
 * never loads it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { loadOnce } from "../../../lib/internal/single-flight.ts";
import type { Answer } from "./shared.ts";
import { renderAnswer, renderInvocation } from "./view.ts";

const readModule = loadOnce(() => import("./read.ts"));

/** What `review` takes. */
const REVIEW_PARAMETERS = Type.Object({
	action: Type.Optional(
		Type.Union(
			[
				Type.Literal("attach"),
				Type.Literal("detach"),
				Type.Literal("next"),
				Type.Literal("prev"),
				Type.Literal("capabilities"),
			],
			{
				description:
					"What to do. attach: work on this change, so later calls can leave it out. detach: stop working on it. next and prev: move the attachment up or down the stack it sits in. capabilities: what this change's provider can do. Omit entirely to report what is attached.",
			},
		),
	),
	change: Type.Optional(
		Type.String({
			description: "Reference to a hosted change: URL, short form or number.",
		}),
	),
	repo: Type.Optional(
		Type.String({ description: "Checkout path for a local review." }),
	),
	base: Type.Optional(
		Type.String({
			description: "Base ref, with head, for a local range.",
		}),
	),
	head: Type.Optional(
		Type.String({
			description: "Head ref, with base, for a local range.",
		}),
	),
	refs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Ordered refs to review as one stack.",
		}),
	),
});

/** What a call of `review` passes. */
export type ReviewParams = Static<typeof REVIEW_PARAMETERS>;

/** Register the `review` tool. */
export function registerReviewTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review",
		// Called in 14 of 66 sessions from 18 October, and the review-guide
		// skill names it, so it loads when that is read.
		exposure: "deferred",
		label: "Review",
		description:
			"Say what you are working on, so no other call has to repeat it: attach a change, detach it, step up or down the stack it sits in, or ask what its provider can do. Call with no action to report what is attached.",
		promptSnippet:
			"Say what you are working on: attach, detach, next, prev, capabilities.",
		promptGuidelines: [
			"Attach a change once and every later call can leave it out. Use review_see to read, review_say to answer a remark, review_draft to compose a whole review.",
			// Said once here for every review tool, rather than once on each:
			// every tool's rules are read on every turn.
			"A change can be a URL, an owner/repo#number short form or a bare number; or pass base and head, or refs, for something nobody has proposed. Leave it out to use the attached change.",
			"Never assume GitHub. The provider is resolved from config, then provider claims, then the reference's shape.",
			"When a stack or a capability is missing, say which provider was asked rather than reporting a generic failure.",
			"review_say and review_offer open a confirmation gate for every action, so describe what you are about to do before calling them.",
		],
		parameters: REVIEW_PARAMETERS,

		renderCall(args, theme, context) {
			const params = args as { action?: string; change?: string };
			return renderInvocation(
				theme,
				"review",
				params.action,
				params.change,
				context?.lastComponent,
			);
		},

		renderResult(result, options, theme, context) {
			return renderAnswer(result, theme, options, context?.lastComponent);
		},

		async execute(_id, params, _signal, _onUpdate, ctx): Promise<Answer> {
			const { runReview } = await readModule();
			return runReview(pi, params, ctx);
		},
	});
}
