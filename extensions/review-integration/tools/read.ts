/**
 * The `review` tool: what this session is working on.
 *
 * Not a reading tool. Reading is `review_see`; this is the one
 * place the question "which change are we talking about" gets
 * answered, so that every other tool can stop asking it.
 *
 * Capabilities lives here rather than with the reads because it
 * is a question about the binding, not about the change: what
 * can be done to this thing, given who is hosting it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	changeInPlay,
	chooseChange,
	createAttachmentStore,
} from "../../../lib/review/index.js";
import { stackStep } from "../../../lib/review/stack.js";
import { attachmentDir } from "../engine.js";
import { GLYPH } from "../render.js";
import {
	type Answer,
	boundFor,
	hostedChange,
	messageOf,
	refuse,
	renderAnswer,
	renderInvocation,
	say,
	type TargetParams,
} from "./shared.js";

/** Register the `review` tool. */
export function registerReviewTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review",
		label: "Review",
		description:
			"Say what you are working on, so no other call has to repeat it: attach a change, detach it, step up or down the stack it sits in, or ask what its provider can do. Call with no action to report what is attached.",
		promptSnippet:
			"Say what you are working on: attach, detach, next, prev, capabilities.",
		promptGuidelines: [
			"Attach a change once and every later call can leave it out. Use review_see to read, review_say to answer a remark, review_draft to compose a whole review.",
			"A change can be a URL, an owner/repo#number short form or a bare number.",
			"Never assume GitHub. The provider is resolved from config, then provider claims, then the user's reference shapes.",
			"When a capability is missing, say which provider was asked rather than reporting a generic failure.",
		],
		parameters: Type.Object({
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
					description:
						"Reference to a hosted change: URL, short form or number.",
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
		}),

		renderCall(args, theme) {
			const params = args as { action?: string; change?: string };
			return renderInvocation(theme, "review", params.action, params.change);
		},

		renderResult(result, _state, theme) {
			return renderAnswer(result, theme);
		},

		async execute(_id, params): Promise<Answer> {
			try {
				if (params.action === undefined) return reportAttached();
				if (params.action === "attach") return attachChange(pi, params);
				if (params.action === "detach") return detachChange(params);
				if (params.action === "next" || params.action === "prev") {
					return stepAttachment(pi, params, params.action);
				}

				const bound = await boundFor(pi, params, process.cwd());
				return say(describeCapabilities(bound));
			} catch (error) {
				return refuse(messageOf(error));
			}
		},
	});
}

/**
 * Attach a change, so later calls need not name it.
 *
 * Creating the attachment resolves the reference first, which
 * means an unreachable or misspelled change is refused here
 * rather than silently becoming the thing every later call
 * fails on.
 */
async function attachChange(
	pi: ExtensionAPI,
	params: TargetParams,
): Promise<Answer> {
	const bound = await boundFor(pi, params, process.cwd());
	const change = hostedChange(bound);
	if (!change) {
		return refuse(
			`A ${bound.target.kind} in ${bound.repo.key} is not something to attach, since nothing hosts it. Pass its base and head on each call instead.`,
		);
	}
	await createAttachmentStore(attachmentDir()).attach(change);
	return say(
		`${GLYPH.target} attached ${change.label}, handled by ${bound.provider.id}.\n   Later calls can leave the change out.`,
		{ ok: true, attached: change.label },
	);
}

/** Stop working on a change. */
async function detachChange(params: TargetParams): Promise<Answer> {
	const store = createAttachmentStore(attachmentDir());
	const attached = await store.list();
	const chosen = changeInPlay(
		params.change,
		undefined,
		attached.map((a) => a.change.label),
	);
	if ("candidates" in chosen) return refuse(chooseChange(chosen.candidates));
	if (!(await store.detach(chosen.label))) {
		return refuse(
			`${chosen.label} was not attached, so there was nothing to detach.`,
		);
	}
	return say(`${GLYPH.target} detached ${chosen.label}.`, {
		ok: true,
		detached: chosen.label,
	});
}

/**
 * Move the attachment along the stack the change sits in.
 *
 * Walking a stack is reading four changes in turn, and naming
 * each one is exactly the restatement attaching exists to remove.
 * The step is honest about a stack that forks: a node with two
 * children has no single answer, so both are offered rather than
 * one being picked and the reader landing on a sibling branch
 * without being told.
 */
async function stepAttachment(
	pi: ExtensionAPI,
	params: TargetParams,
	direction: "next" | "prev",
): Promise<Answer> {
	const bound = await boundFor(pi, params, process.cwd());
	const change = hostedChange(bound);
	if (!change) {
		return refuse(
			`A ${bound.target.kind} in ${bound.repo.key} is not in a stack of changes, so there is nothing to step through.`,
		);
	}
	const proposal = await bound.proposal();
	const standing = proposal?.head;
	if (standing === undefined) {
		return refuse(
			`${change.label} does not report the ref it is on, so ${direction} has nowhere to start.`,
		);
	}
	const stack = await bound.stack();
	if (!stack) {
		return refuse(
			`The ${bound.provider.id} provider does not report stacks, so there is nothing to step through.`,
		);
	}
	const step = stackStep(stack, standing, direction);

	if (step.kind === "unplaced") {
		return refuse(
			`${bound.provider.id} reports a stack that does not place ${standing}, so it cannot say what is ${direction === "next" ? "above" : "below"} it.`,
		);
	}
	if (step.kind === "edge") {
		return say(
			step.at === "tip"
				? `${GLYPH.stack} ${change.label} is the top of its stack, so there is nothing above it.`
				: `${GLYPH.stack} ${change.label} sits on ${stack.trunk ?? "the trunk"}, so there is nothing below it.`,
			{ ok: true, at: step.at },
		);
	}
	if (step.kind === "choose") {
		const names = step.candidates.map((c) => c.proposal?.ref.label ?? c.ref);
		return refuse(
			`${change.label} forks into ${names.join(" and ")}. Attach the one you mean, since picking for you would move you onto a sibling branch without saying so.`,
		);
	}

	const landing = step.node.proposal?.ref;
	if (!landing) {
		return refuse(
			`${step.node.ref} is ${direction === "next" ? "above" : "below"} ${change.label} but nothing hosts it yet, so there is no change to attach. Offer it for review first.`,
		);
	}
	const store = createAttachmentStore(attachmentDir());
	await store.attach(landing);
	await store.detach(change.label);
	return say(
		`${GLYPH.stack} moved ${direction === "next" ? "up" : "down"} to ${landing.label}, and attached it.\n   Left ${change.label} behind.`,
		{ ok: true, attached: landing.label },
	);
}

/** What this session is working on. */
async function reportAttached(): Promise<Answer> {
	const attached = await createAttachmentStore(attachmentDir()).list();
	if (attached.length === 0) {
		return say(
			`${GLYPH.target} nothing attached. Attach a change and every call after it can leave the change out.`,
			{ ok: true, count: 0 },
		);
	}
	const lines = attached.map(
		(a) => `   ${a.change.label}  ${a.change.provider}`,
	);
	return say(`${GLYPH.target} attached, newest first\n${lines.join("\n")}`, {
		ok: true,
		count: attached.length,
	});
}

/**
 * What a provider says it can do, in plain lines.
 *
 * The header names the provider and what it is holding, because
 * "who handles this" and "what can be done to it" are the same
 * question asked twice, and answering both here is what let the
 * separate resolve action go.
 */
function describeCapabilities(
	bound: Awaited<ReturnType<typeof boundFor>>,
): string {
	const caps = bound.capabilities;
	const subject =
		bound.target.kind === "proposal"
			? bound.target.change.label
			: `a ${bound.target.kind} in ${bound.repo.key}`;
	const lines = [
		`${GLYPH.target} ${bound.provider.id} handles ${subject}`,
		`   conversation: ${caps.conversation ? "yes" : "no"}`,
		`   stacking: ${caps.stacking?.provenance ?? "none"}`,
		`   proposals: ${caps.proposals ? "yes" : "no"}`,
	];
	const conversation = caps.conversation;
	if (conversation) {
		const cap = conversation.maxBatchComments;
		lines.push(
			`   anchored batch review: ${conversation.anchoredBatchReview}${cap ? ` (at most ${cap} per review)` : ""}`,
			`   ranges: ${conversation.multiLineRanges} · whole-file remarks: ${conversation.fileLevelComments} · reopen: ${conversation.unresolve}`,
			`   reactions: ${conversation.reactions.length > 0 ? conversation.reactions.join(" ") : "none"}`,
			`   stale anchors: ${conversation.staleness}`,
		);
	}
	return lines.join("\n");
}
