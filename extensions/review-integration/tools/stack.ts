/**
 * The `review_stack` tool: what this change sits on.
 *
 * The answer always says where the shape came from, because a
 * derived stack and a recorded one deserve different amounts of
 * trust and the difference is invisible otherwise.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { stackLines } from "../render.js";
import {
	type Answer,
	boundFor,
	messageOf,
	refuse,
	renderAnswer,
	renderInvocation,
	say,
} from "./shared.js";

/** Register the `review_stack` tool. */
export function registerStackTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review_stack",
		label: "Review Stack",
		description:
			"Read the stack a change or branch belongs to, marked with where its shape came from: recorded by the backend, or derived from branch names and therefore fallible.",
		promptSnippet:
			"Read the stack a change or branch sits in, with its provenance marked.",
		promptGuidelines: [
			"A derived stack can be wrong at the edges: a merged parent or a renamed branch ends the chain early. Pass that caveat on when it matters to the answer.",
			"A stack of branches nobody has proposed is still a stack; pass refs to read one.",
		],
		parameters: Type.Object({
			change: Type.Optional(
				Type.String({ description: "A hosted change in the stack." }),
			),
			repo: Type.Optional(
				Type.String({ description: "Checkout path for a local stack." }),
			),
			refs: Type.Optional(
				Type.Array(Type.String(), {
					description: "Local refs; the last is treated as the cursor.",
				}),
			),
			base: Type.Optional(Type.String({ description: "Base of a range." })),
			head: Type.Optional(Type.String({ description: "Head of a range." })),
		}),

		renderCall(args, theme) {
			const params = args as { change?: string };
			return renderInvocation(theme, "review_stack", undefined, params.change);
		},

		renderResult(result, _state, theme) {
			return renderAnswer(result, theme);
		},

		async execute(_id, params): Promise<Answer> {
			try {
				const bound = await boundFor(pi, params, process.cwd());
				const stack = await bound.stack();
				if (!stack) {
					return refuse(
						`The ${bound.provider.id} provider does not read stacks, so there is no topology to show for this target.`,
					);
				}
				return say(stackLines(stack), {
					ok: true,
					nodes: stack.nodes.length,
					provenance: stack.provenance,
				});
			} catch (error) {
				return refuse(messageOf(error));
			}
		},
	});
}
