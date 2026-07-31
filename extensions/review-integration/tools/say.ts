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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	type ConversationFacet,
	findReactable,
	isReactableRefusal,
	type Reaction,
	reactables,
	type Thread,
} from "../../../lib/review/index.js";
import { confirmWrite } from "../gate.js";
import { anchorLabel, GLYPH } from "../render.js";
import {
	type Answer,
	boundFor,
	hostedChange,
	messageOf,
	refuse,
	renderAnswer,
	renderInvocation,
	say,
	threadsOf,
} from "./shared.js";

/** Where a thread hangs, for a gate to show. */
function threadWhere(thread: Thread): string {
	return thread.anchor ? anchorLabel(thread.anchor) : "on the change itself";
}

/** Register the `review_say` tool. */
export function registerSayTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review_say",
		label: "Review Say",
		description:
			"Say something on a change, straight away: reply into a thread, resolve or reopen one, react to a comment, or post a top-level message. Reading the conversation is review_see.",
		promptSnippet:
			"Say something on a change now: reply, comment, resolve, unresolve, react.",
		promptGuidelines: [
			"Read the threads with review_see first, and refer to a thread by the [T#] index that listing shows. Never invent or guess a thread id.",
			"React by the address a listing prints: [C#] for a remark inside a thread, [M#] for a top-level message. A bare number is refused, since it does not say which of the two.",
			"Leave the change out to speak on whatever is attached.",
			"Use this to answer one remark. To compose several remarks and a verdict together, use review_draft.",
			"Every action here opens a confirmation gate, so describe what you are about to post before calling it.",
		],
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("reply"),
					Type.Literal("comment"),
					Type.Literal("resolve"),
					Type.Literal("unresolve"),
					Type.Literal("react"),
				],
				{
					description:
						"What to say. reply: answer one thread. comment: a top-level remark on the change. resolve and unresolve: close or reopen a thread. react: put a reaction on one comment.",
				},
			),
			change: Type.Optional(
				Type.String({
					description:
						"The hosted change. Omit to speak on the attached change.",
				}),
			),
			thread: Type.Optional(
				Type.Number({
					description: "1-based [T#] index from the threads listing.",
				}),
			),
			body: Type.Optional(
				Type.String({
					description: "For reply and comment: the text to post.",
				}),
			),
			reaction: Type.Optional(
				Type.String({ description: "Reaction name, e.g. rocket." }),
			),
			comment: Type.Optional(
				Type.String({
					description:
						"For react: which comment, as the [C#] a thread listing prints beside a remark or the [M#] a messages listing prints beside a top-level one.",
				}),
			),
		}),

		renderCall(args, theme) {
			const params = args as { action?: string; change?: string };
			return renderInvocation(
				theme,
				"review_say",
				params.action,
				params.change,
			);
		},

		renderResult(result, _state, theme) {
			return renderAnswer(result, theme);
		},

		async execute(_id, params, _signal, _onUpdate, ctx): Promise<Answer> {
			try {
				const bound = await boundFor(pi, params, process.cwd());
				const conversation = bound.conversation;
				const change = hostedChange(bound);
				if (!conversation || !change) {
					return refuse(
						"Nothing hosts this target, so it has no conversation. Compose a review with review_draft and render it as a document.",
					);
				}

				if (params.action === "comment") {
					if (!params.body) return refuse("A comment needs a body.");
					const approved = await confirmWrite(
						ctx,
						"Post a comment?",
						`${GLYPH.target} ${change.label}\n\n${params.body}`,
					);
					if (!approved) return say("Left unposted.");
					const posted = await conversation.comment(change, params.body);
					return say(
						`${GLYPH.lands} posted${posted.url ? `\n   ${posted.url}` : ""}`,
					);
				}

				if (params.action === "react") {
					return react(ctx, conversation, bound, params);
				}

				const threads = await threadsOf(bound);
				const thread = threads[(params.thread ?? 0) - 1];
				if (!thread) {
					return refuse(
						`There is no [T${params.thread ?? "?"}] on this change. Read the threads first; the listing numbers them.`,
					);
				}

				if (params.action === "reply") {
					if (!params.body) return refuse("A reply needs a body.");
					const approved = await confirmWrite(
						ctx,
						"Post this reply?",
						`${GLYPH.thread} ${threadWhere(thread)}\n\n${params.body}`,
					);
					if (!approved) return say("Left unposted.");
					const posted = await conversation.reply(change, thread, params.body);
					return say(
						`${GLYPH.lands} replied${posted.url ? `\n   ${posted.url}` : ""}`,
					);
				}

				const reopening = params.action === "unresolve";
				if (reopening && !conversation.unresolve) {
					return refuse(
						`The ${bound.provider.id} provider cannot reopen a resolved thread.`,
					);
				}
				const approved = await confirmWrite(
					ctx,
					reopening ? "Reopen this thread?" : "Resolve this thread?",
					`${GLYPH.thread} ${threadWhere(thread)}`,
				);
				if (!approved) return say("Left as it was.");
				if (reopening) await conversation.unresolve?.(change, thread);
				else await conversation.resolve(change, thread);
				return say(
					`${reopening ? GLYPH.unresolved : GLYPH.resolved} ${reopening ? "reopened" : "resolved"}.`,
				);
			} catch (error) {
				return refuse(messageOf(error));
			}
		},
	});
}

/** React to one comment, if the provider accepts that reaction. */
async function react(
	ctx: Parameters<typeof confirmWrite>[0],
	conversation: ConversationFacet,
	bound: Awaited<ReturnType<typeof boundFor>>,
	params: { reaction?: string; comment?: string },
): Promise<Answer> {
	const change = hostedChange(bound);
	if (!change) return refuse("This target is not a hosted change.");
	if (!params.reaction || !params.comment) {
		return refuse(
			"Reacting needs a reaction and the comment to put it on, addressed as the [C#] or [M#] a listing prints.",
		);
	}
	if (!conversation.react) {
		return refuse(
			`The ${bound.provider.id} provider does not support reactions.`,
		);
	}
	const allowed = bound.capabilities.conversation?.reactions ?? [];
	if (!allowed.includes(params.reaction as Reaction)) {
		return refuse(
			allowed.length > 0
				? `That provider accepts ${allowed.join(", ")}.`
				: "That provider accepts no reactions.",
		);
	}
	// Resolved against the conversation as it actually is, rather than
	// trusting whatever was typed. This used to hand the provider a comment
	// invented on the spot, `{ id: whatever was asked for, author: "", body:
	// "" }`, which works only for a provider that reads nothing but the id and
	// sends every other one a comment with no author and nothing said. It also
	// meant a wrong id was found out by the backend rather than here, so the
	// failure arrived as somebody else's error message.
	const [threads, messages] = await Promise.all([
		conversation.threads(change),
		conversation.messages(change),
	]);
	const found = findReactable(
		params.comment,
		reactables({ threads, messages }),
	);
	if (isReactableRefusal(found)) return refuse(found.reason);

	// The gate quotes the remark being reacted to, since an address is not
	// something a person can check. `[C4]` approved against the wrong comment
	// is indistinguishable from `[C4]` approved against the right one.
	const approved = await confirmWrite(
		ctx,
		`React ${params.reaction}?`,
		`${GLYPH.reaction} ${params.reaction} on ${found.label} ${found.message.author.id}: ${found.message.body}`,
	);
	if (!approved) return say("Left as it was.");
	await conversation.react(change, found.message, params.reaction as Reaction);
	return say(`${GLYPH.reaction} reacted to ${found.label}.`);
}
