/**
 * The `review_say` tool as pi sees it: its schema, its words and how
 * its call and answer read. What a call does is in `say.ts`, loaded
 * on the tool's first call, so a session that never speaks on a
 * change never loads it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import type { SayItem } from "./batch.ts";
import type { Answer } from "./shared.ts";
import { renderAnswer, renderInvocation } from "./view.ts";

/** What `review_say` takes. */
const SAY_PARAMETERS = Type.Object({
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
			description: "The hosted change. Omit to speak on the attached change.",
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
					"For reply: what to do with the thread once the reply lands. Defaults to leave, since resolving closes somebody else's conversation.",
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
					"Several things to say at once behind one gate, each shaped like the singular parameters with its own action. Not alongside the singular ones.",
			},
		),
	),
});

/** What a call of `review_say` passes. */
export type SayParams = Static<typeof SAY_PARAMETERS>;

/** Register the `review_say` tool. */
export function registerSayTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review_say",
		// Called in 16 of 69 sessions from 18 October, and the review-guide
		// skill names it, so it loads when that is read.
		exposure: "deferred",
		label: "Review Say",
		description:
			"Say something on a change, straight away: reply into a thread, resolve or reopen one, react to a comment, start a thread on a line, or post a top-level message. Several at once through items, behind one gate. Reading the conversation is review_see.",
		promptSnippet:
			"Say something on a change now: reply, comment, annotate, resolve, unresolve, react, or several at once.",
		promptGuidelines: [
			"Read the threads with review_see first, and refer to a thread by the [T#] index that listing shows. Never invent or guess a thread id.",
			"React by the address a listing prints: [C#] for a remark inside a thread, [M#] for a top-level message. A bare number is refused, since it does not say which of the two.",
			"Answering several threads is one call: put them in items, which opens one gate with a tab each rather than one gate per reply.",
			"Set settleThread to resolve when the reply answers what the thread asked for, so answering and closing cost one call rather than two. The gate prints the decision either way, so say it rather than leaving it to be guessed.",
			"Use this to answer remarks. To compose several remarks and a verdict as one review, use review_draft.",
		],
		parameters: SAY_PARAMETERS,

		renderCall(args, theme, context) {
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
				context?.lastComponent,
			);
		},

		renderResult(result, options, theme, context) {
			return renderAnswer(result, theme, options, context?.lastComponent);
		},

		async execute(_id, params, _signal, _onUpdate, ctx): Promise<Answer> {
			const { saySomething } = await import("./say.ts");
			return saySomething(pi, params, ctx);
		},
	});
}
