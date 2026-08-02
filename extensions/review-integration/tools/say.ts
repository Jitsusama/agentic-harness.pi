/**
 * The `review_say` tool: saying something, now.
 *
 * This is the flow an author lives in on their own change, and
 * it is deliberately ceremony-free: reply, resolve, react. The
 * ceremony belongs to `review_draft`, which composes a whole
 * review rather than answering one remark, and the overlap
 * between the two is kept on purpose: answering one comment and
 * composing a review that happens to answer it are different
 * acts, and forcing the first through a draft would be ceremony
 * for its own sake.
 *
 * Reading the conversation belongs to `review_see`. This tool
 * only writes, so every action here asks first.
 *
 * Registration only. What each action does, and what its gate shows,
 * lives in `batch.ts`, because the singular parameters are read as a
 * batch of one and both go down the same road.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BoundTarget } from "../../../lib/review/index.js";
import { batchRefusal, runBatch, type SayItem } from "./batch.js";
import {
	type Answer,
	boundFor,
	hostedChange,
	refuse,
	refuseFailure,
	renderAnswer,
	renderInvocation,
	threadsOf,
} from "./shared.js";

/** Register the `review_say` tool. */
export function registerSayTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review_say",
		label: "Review Say",
		description:
			"Say something on a change, straight away: reply into a thread, resolve or reopen one, react to a comment, start a thread on a line, or post a top-level message. Several at once through items, behind one gate. Reading the conversation is review_see.",
		promptSnippet:
			"Say something on a change now: reply, comment, annotate, resolve, unresolve, react, or several at once.",
		promptGuidelines: [
			"Read the threads with review_see first, and refer to a thread by the [T#] index that listing shows. Never invent or guess a thread id.",
			"React by the address a listing prints: [C#] for a remark inside a thread, [M#] for a top-level message. A bare number is refused, since it does not say which of the two.",
			"Leave the change out to speak on whatever is attached.",
			"Answering several threads is one call: put them in items, which opens one gate with a tab each rather than one gate per reply.",
			"Set settleThread to resolve when the reply answers what the thread asked for, so answering and closing cost one call rather than two. The gate prints the decision either way, so say it rather than leaving it to be guessed.",
			"Use this to answer remarks. To compose several remarks and a verdict as one review, use review_draft.",
			"Every action here opens a confirmation gate, so describe what you are about to post before calling it.",
		],
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union(
					[
						Type.Literal("reply"),
						Type.Literal("comment"),
						Type.Literal("annotate"),
						Type.Literal("resolve"),
						Type.Literal("unresolve"),
						Type.Literal("react"),
					],
					{
						description:
							"What to say. reply: answer one thread. comment: a top-level remark on the change. annotate: start a thread on a line. resolve and unresolve: close or reopen a thread. react: put a reaction on one comment. Omit it when using items, where every entry names its own.",
					},
				),
			),
			change: Type.Optional(
				Type.String({
					description:
						"The hosted change. Omit to speak on the attached change.",
				}),
			),
			thread: Type.Optional(
				Type.Number({
					description:
						"For reply, resolve and unresolve: 1-based [T#] index from the threads listing.",
				}),
			),
			body: Type.Optional(
				Type.String({
					description: "For reply, comment and annotate: the text to post.",
				}),
			),
			reaction: Type.Optional(
				Type.String({ description: "For react: the reaction, e.g. rocket." }),
			),
			comment: Type.Optional(
				Type.String({
					description:
						"For react: which comment, as the [C#] a thread listing prints beside a remark or the [M#] a messages listing prints beside a top-level one.",
				}),
			),
			path: Type.Optional(
				Type.String({
					description: "For annotate: the file the remark is about.",
				}),
			),
			line: Type.Optional(
				Type.Number({ description: "For annotate: the line it points at." }),
			),
			startLine: Type.Optional(
				Type.Number({
					description: "For annotate: the first line of a range.",
				}),
			),
			side: Type.Optional(
				Type.Union([Type.Literal("old"), Type.Literal("new")], {
					description: "For annotate: which side of the diff. Defaults to new.",
				}),
			),
			// Named the same as review_draft's, since it is the same decision on
			// the same thing, and that tool's plain `settle` was already spoken
			// for by what becomes of a finding.
			settleThread: Type.Optional(
				Type.Union(
					[
						Type.Literal("resolve"),
						Type.Literal("unresolve"),
						Type.Literal("leave"),
					],
					{
						description:
							"For reply: what to do with the thread once the reply lands, so answering and closing cost one call rather than two. Defaults to leaving it as it is, since resolving closes somebody else's conversation.",
					},
				),
			),
			items: Type.Optional(
				Type.Array(
					Type.Object({
						action: Type.String(),
						thread: Type.Optional(Type.Number()),
						body: Type.Optional(Type.String()),
						settleThread: Type.Optional(Type.String()),
						comment: Type.Optional(Type.String()),
						reaction: Type.Optional(Type.String()),
						path: Type.Optional(Type.String()),
						line: Type.Optional(Type.Number()),
						startLine: Type.Optional(Type.Number()),
						side: Type.Optional(Type.String()),
					}),
					{
						description:
							"Several things to say at once, each shaped like the singular parameters and each naming its own action. One gate covers them all, a tab each. Do not pass the singular parameters alongside it.",
					},
				),
			),
		}),

		renderCall(args, theme) {
			const params = args as {
				action?: string;
				change?: string;
				items?: SayItem[];
			};
			return renderInvocation(
				theme,
				"review_say",
				params.items ? `${params.items.length} things` : params.action,
				params.change,
			);
		},

		renderResult(result, options, theme) {
			return renderAnswer(result, theme, options);
		},

		async execute(_id, params, _signal, _onUpdate, ctx): Promise<Answer> {
			// Held outside the try so a failure can say which provider was asked.
			let bound: BoundTarget | undefined;
			try {
				bound = await boundFor(pi, params, process.cwd());
				const conversation = bound.conversation;
				const change = hostedChange(bound);
				if (!conversation || !change) {
					return refuse(
						"Nothing hosts this target, so it has no conversation. Compose a review with review_draft and render it as a document.",
					);
				}

				const cannot = batchRefusal(params as Record<string, unknown>);
				if (cannot) return refuse(cannot);
				if (!params.action && !params.items) {
					return refuse("Say what to do: an action, or a batch of items.");
				}

				// The singular parameters are read as a batch of one, so there is
				// one road through this tool rather than two that agree today.
				const items = (params.items as SayItem[] | undefined) ?? [
					params as SayItem,
				];

				// One read of the conversation for the whole call, so [T26] cannot
				// mean two different threads inside one gate. Skipped entirely
				// when nothing in the batch refers to a thread.
				const threads = items.some((one) => one.thread !== undefined)
					? await threadsOf(bound)
					: [];

				return await runBatch(ctx, bound, conversation, change, threads, items);
			} catch (error) {
				return refuseFailure(error, bound);
			}
		},
	});
}
