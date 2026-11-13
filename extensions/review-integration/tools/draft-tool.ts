/**
 * The `review_draft` tool as pi sees it: its schema, its words and how
 * its call and answer read. What a call does is in `draft.ts`,
 * loaded on the tool's first call, so a session that never calls it
 * never loads it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { loadOnce } from "../../../lib/internal/single-flight.ts";
import type { Answer } from "./shared.ts";
import { renderAnswer, renderInvocation } from "./view.ts";

const draftModule = loadOnce(() => import("./draft.ts"));

/** What `review_draft` takes. */
const DRAFT_PARAMETERS = Type.Object({
	action: Type.Union(
		[
			Type.Literal("open"),
			Type.Literal("show"),
			Type.Literal("finding"),
			Type.Literal("decide"),
			Type.Literal("reply"),
			Type.Literal("resolve"),
			Type.Literal("unresolve"),
			Type.Literal("react"),
			Type.Literal("verdict"),
			Type.Literal("drop"),
			Type.Literal("plan"),
			Type.Literal("publish"),
			Type.Literal("publish-stack"),
			Type.Literal("render"),
			Type.Literal("fix-next"),
			Type.Literal("fix-done"),
			Type.Literal("fix-skip"),
			Type.Literal("fix-answered"),
			Type.Literal("fixes"),
			Type.Literal("take-threads"),
		],
		{ description: "What to do with the draft." },
	),
	change: Type.Optional(
		Type.String({ description: "The hosted change under review." }),
	),
	repo: Type.Optional(Type.String({ description: "Checkout path." })),
	base: Type.Optional(Type.String({ description: "Base of a range." })),
	head: Type.Optional(Type.String({ description: "Head of a range." })),
	refs: Type.Optional(
		Type.Array(Type.String(), { description: "Refs of a local stack." }),
	),
	draft: Type.Optional(
		Type.String({ description: "Draft id, to resume a specific one." }),
	),
	path: Type.Optional(
		Type.String({
			description: "For finding: the file the remark is about.",
		}),
	),
	line: Type.Optional(
		Type.Number({
			description:
				"For finding: the line it points at; omit for a whole-file remark.",
		}),
	),
	startLine: Type.Optional(
		Type.Number({
			description: "For finding: the first line of a range.",
		}),
	),
	side: Type.Optional(
		Type.Union([Type.Literal("old"), Type.Literal("new")], {
			description: "For finding: which side of the diff. Defaults to new.",
		}),
	),
	body: Type.Optional(
		Type.String({
			description:
				"For finding, reply, verdict, decide and fix-answered: the text. The remark for finding, the answer for reply, the summary for verdict, the finding in your own words for decide, and what you said for fix-answered.",
		}),
	),
	thread: Type.Optional(
		Type.Number({
			description:
				"For reply, resolve and unresolve: the 1-based [T#] index of a thread.",
		}),
	),
	// Not `settle`, which this tool already uses for what becomes of a
	// finding. One word, one meaning: a parameter bag where `settle`
	// means two things depending on the action is a bag nobody can read.
	settleThread: Type.Optional(
		Type.Union(
			[
				Type.Literal("resolve"),
				Type.Literal("unresolve"),
				Type.Literal("leave"),
			],
			{
				description:
					"For reply: what to do with the thread once the reply lands, queued as its own item beside the reply. Defaults to leaving it as it is.",
			},
		),
	),
	reaction: Type.Optional(
		Type.String({ description: "For react: the reaction name." }),
	),
	comment: Type.Optional(
		Type.String({
			description:
				"For react: which comment, as the [C#] a thread listing prints beside a remark or the [M#] a messages listing prints beside a top-level one.",
		}),
	),
	verdict: Type.Optional(
		Type.Union(
			[
				Type.Literal("approve"),
				Type.Literal("request-changes"),
				Type.Literal("comment"),
			],
			{
				description: "For verdict: what to say about the change as a whole.",
			},
		),
	),
	commit: Type.Optional(
		Type.String({
			description:
				"For fix-done: the commit that landed the fix. Required, since a fix recorded without one cannot be checked.",
		}),
	),
	item: Type.Optional(
		Type.String({
			description: "For drop: the item id to take out of the draft.",
		}),
	),
	finding: Type.Optional(
		Type.Number({
			description:
				"For decide, fix-done, fix-skip and fix-answered: the [F#] number of the item, as review_see findings and review_draft fixes list them.",
		}),
	),
	settle: Type.Optional(
		Type.Union(
			[Type.Literal("promote"), Type.Literal("dismiss"), Type.Literal("fix")],
			{
				description:
					"For decide: promote puts the finding into this draft as a remark, dismiss drops it, fix queues it as work to do rather than something to say. Pass body with promote to say it in your own words, or with fix to note how you mean to fix it.",
			},
		),
	),
});

/** What a call of `review_draft` passes. */
export type DraftParams = Static<typeof DRAFT_PARAMETERS>;

/** Register the `review_draft` tool. */
export function registerDraftTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review_draft",
		// Used in 15 of 80 sessions from 8 October, and review-guide names
		// it, so reading that skill loads it: loaded on demand.
		exposure: "deferred",
		label: "Review Draft",
		description:
			"Compose a review and land it in one go: add anchored findings, replies into existing threads, resolutions, reactions and a verdict; see exactly what publishing will do, including what degrades and why; then publish, or render the review as a document when nothing hosts the target.",
		promptSnippet:
			"Compose a review as a draft, see what publishing would do, then publish or render it.",
		promptGuidelines: [
			"Always plan before publishing, and tell the user what will degrade and why rather than letting them discover it afterwards.",
			"A draft persists, so a review can be built up across a session and picked back up by id.",
			"When the target has nowhere to post, render the draft as a document instead of reporting failure.",
			"Publishing keeps whatever did not land, so a retry sends only the remainder. Say so if something fails.",
		],
		parameters: DRAFT_PARAMETERS,

		renderCall(args, theme, context) {
			const params = args as { action?: string; change?: string };
			return renderInvocation(
				theme,
				"review_draft",
				params.action,
				params.change,
				context?.lastComponent,
			);
		},

		renderResult(result, options, theme, context) {
			return renderAnswer(result, theme, options, context?.lastComponent);
		},

		async execute(_id, params, signal, _onUpdate, ctx): Promise<Answer> {
			const { runDraft } = await draftModule();
			return runDraft(pi, params, signal, ctx);
		},
	});
}
