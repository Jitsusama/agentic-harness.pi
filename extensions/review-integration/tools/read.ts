/**
 * The `review` tool: reading a change, whatever hosts it.
 *
 * Read-only, so no gate. The one thing it must never do is
 * assume a backend: every answer here comes from whichever
 * provider claimed the reference.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { citeListing, openSessionStore } from "../../../lib/result/index.js";
import {
	changeInPlay,
	chooseChange,
	createAttachmentStore,
} from "../../../lib/review/index.js";
import { attachmentDir, reviewEngine } from "../engine.js";
import { checksLines, GLYPH, proposalLine } from "../render.js";
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
			"Read a change under review: resolve a reference, view the change, its diff, its checks, sibling changes, or what its provider can do. Works for hosted changes and for local ranges and stacks that nothing hosts.",
		promptSnippet:
			"Read a change under review, whatever hosts it: resolve, view, diff, checks, list, capabilities.",
		promptGuidelines: [
			"Use review to read, review_thread to reply or resolve, review_draft to compose a whole review.",
			"A change can be a URL, an owner/repo#number short form or a bare number; or omit it and pass base and head, or refs, to review something nobody has proposed.",
			"Never assume GitHub. The provider is resolved from config, then provider claims, then the user's reference shapes.",
			"When a stack or a capability is missing, say which provider was asked rather than reporting a generic failure.",
		],
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union(
					[
						Type.Literal("attach"),
						Type.Literal("detach"),
						Type.Literal("resolve"),
						Type.Literal("view"),
						Type.Literal("diff"),
						Type.Literal("checks"),
						Type.Literal("list"),
						Type.Literal("capabilities"),
					],
					{
						description:
							"What to do. attach: work on this change, so later calls can leave it out. detach: stop working on it. Omit entirely to report what is attached.",
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
			state: Type.Optional(
				Type.Union(
					[
						Type.Literal("open"),
						Type.Literal("merged"),
						Type.Literal("closed"),
					],
					{ description: "For list: which changes." },
				),
			),
			limit: Type.Optional(Type.Number({ description: "For list: how many." })),
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
				if (params.action === "list") return listChanges(pi, params);

				const bound = await boundFor(pi, params, process.cwd());

				if (params.action === "resolve") {
					const subject =
						bound.target.kind === "proposal"
							? bound.target.change.id
							: bound.repo.key;
					return say(
						`${GLYPH.target} ${bound.provider.id} handles ${subject}\n   a ${bound.target.kind} target in ${bound.repo.key}`,
						{ ok: true, provider: bound.provider.id },
					);
				}

				if (params.action === "capabilities") {
					return say(describeCapabilities(bound));
				}

				if (params.action === "view") {
					const proposal = await bound.proposal();
					if (!proposal) {
						return say(
							`${GLYPH.target} a ${bound.target.kind} in ${bound.repo.key}, which nothing hosts. Review it and render the result.`,
						);
					}
					return say(`${proposalLine(proposal)}\n\n${proposal.body}`);
				}

				if (params.action === "checks") {
					const checks = await bound.checks();
					if (!checks) {
						return say(
							`${GLYPH.checks} the ${bound.provider.id} provider reports no checks for this target.`,
						);
					}
					return say(checksLines(checks), {
						ok: true,
						state: checks.state,
					});
				}

				const diff = await bound.diff();
				const model = await bound.diffModel();
				return say(
					citeListing(openSessionStore(), {
						view: diff,
						records: model.files,
						unit: "files",
						narrowing:
							"Query the stored result for the files or hunks you need.",
					}),
					{ ok: true, files: model.files.length },
				);
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

/** What a provider says it can do, in plain lines. */
function describeCapabilities(
	bound: Awaited<ReturnType<typeof boundFor>>,
): string {
	const caps = bound.capabilities;
	const lines = [
		`${GLYPH.target} what ${bound.provider.id} can do here`,
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

/** Sibling changes in the same repo. */
async function listChanges(
	pi: ExtensionAPI,
	params: {
		change?: string;
		repo?: string;
		state?: "open" | "merged" | "closed";
		limit?: number;
	},
): Promise<Answer> {
	const { engine } = await reviewEngine(pi);
	const cwd = params.repo ?? process.cwd();
	const bound = params.change
		? await engine.resolve(params.change, cwd)
		: undefined;
	const lister = bound?.provider.proposals?.list;
	if (!bound || !lister) {
		return refuse(
			"Listing needs a provider that can list changes. Name any change in the repo you mean, so the provider can be resolved from it.",
		);
	}
	const found = await lister(bound.repo, {
		...(params.state ? { state: params.state } : {}),
		...(params.limit !== undefined ? { limit: params.limit } : {}),
	});
	if (found.length === 0) {
		return say(`${GLYPH.target} no changes match.`);
	}
	return say(
		citeListing(openSessionStore(), {
			view: found.map(proposalLine).join("\n\n"),
			records: found,
			unit: "changes",
			narrowing: "Narrow with 'state', or lower 'limit'.",
		}),
		{ ok: true, count: found.length },
	);
}
