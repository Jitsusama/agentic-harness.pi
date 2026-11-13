/**
 * The `review_see` tool as pi sees it: its schema, its words and how
 * its call and answer read. What a call does is in `see.ts`,
 * loaded on the tool's first call, so a session that never calls it
 * never loads it.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { loadOnce } from "../../../lib/internal/single-flight.ts";
import { takesUpCarried } from "../../../lib/jobs/take-up.ts";
import { CHECKS_WORK, takeUpChecks } from "../checks-job.ts";
import type { Answer } from "./shared.ts";
import { renderAnswer, renderInvocation } from "./view.ts";

const seeModule = loadOnce(() => import("./see.ts"));

/** What `review_see` takes. */
const SEE_PARAMETERS = Type.Object({
	// An enum rather than a union of literals, as review_offer's: the
	// same choices in a third of the characters sent every turn.
	action: StringEnum(
		[
			"change",
			"diff",
			"checks",
			"stack",
			"changes",
			"threads",
			"reviews",
			"messages",
			"findings",
			"followup",
		] as const,
		{
			description:
				"What to read. change: the change itself and its body. diff: the whole diff. checks: what CI says. stack: what it sits on, with provenance. changes: siblings in the repo. threads: anchored conversation, numbered. reviews: verdicts people left. messages: top-level remarks. findings: what a review pass raised, not yet said to anybody. followup: where your own remarks stand now the change has moved on, worst first.",
		},
	),
	change: Type.Optional(
		Type.String({
			description:
				"Reference to a hosted change: URL, short form or number. Omit to read the attached change.",
		}),
	),
	repo: Type.Optional(
		Type.String({ description: "Checkout path for a local review." }),
	),
	base: Type.Optional(
		Type.String({ description: "Base ref, with head, for a local range." }),
	),
	head: Type.Optional(
		Type.String({ description: "Head ref, with base, for a local range." }),
	),
	refs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Ordered refs to read as one stack.",
		}),
	),
	state: Type.Optional(
		StringEnum(["open", "merged", "closed"] as const, {
			description: "For changes: which ones.",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "For changes: how many." })),
	mine: Type.Optional(
		Type.Boolean({
			description:
				"For reviews: only your own, to check whether you already gave a verdict. Refused where the backend will not say who you are.",
		}),
	),
	watch: Type.Optional(
		Type.Boolean({
			description:
				"For checks: when unsettled, return at once and send the result later as its own message, so you carry on rather than poll.",
		}),
	),
});

/** What a call of `review_see` passes. */
export type SeeParams = Static<typeof SEE_PARAMETERS>;

/** Register the `review_see` tool. */
export function registerSeeTool(pi: ExtensionAPI): void {
	// A watch a move carried into this session watches on here.
	takesUpCarried(pi.events, CHECKS_WORK, (work) =>
		takeUpChecks(work, {
			reading: async (target) => {
				const { checksReading } = await seeModule();
				return checksReading(pi, target);
			},
		}),
	);
	pi.registerTool({
		name: "review_see",
		label: "Review See",
		description:
			"Read a change under review, whatever hosts it: the change itself, its diff, its checks, the stack it sits in, sibling changes in the repo, and the conversation on it as threads, reviews or plain messages. Works for hosted changes and for local ranges and stacks that nothing hosts.",
		promptSnippet:
			"Read a change under review: the change, its diff, checks, stack, sibling changes, and its conversation.",
		promptGuidelines: [
			"Name a change to read it without disturbing the attachment.",
			"A derived stack can be wrong at the edges: a merged parent or a renamed branch ends the chain early. Pass that caveat on when it matters.",
		],
		parameters: SEE_PARAMETERS,

		renderCall(args, theme, context) {
			const params = args as { action?: string; change?: string };
			return renderInvocation(
				theme,
				"review_see",
				params.action,
				params.change,
				context?.lastComponent,
			);
		},

		renderResult(result, options, theme, context) {
			return renderAnswer(result, theme, options, context?.lastComponent);
		},

		async execute(_id, params, _signal, _onUpdate, ctx): Promise<Answer> {
			const { runSee } = await seeModule();
			return runSee(pi, params, ctx);
		},
	});
}
