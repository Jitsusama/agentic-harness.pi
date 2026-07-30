/**
 * The `review_offer` tool: putting work up, and moving it along.
 *
 * The other four tools read a change or talk about one. This is the
 * one that makes a change exist, and it is what closes the gap between
 * having a branch and having something people can review.
 *
 * Every action asks the provider first, through `offerable`, before it
 * asks the network. Reviewing degrades gracefully and authoring does
 * not: a retarget that means something different here moves changes
 * nobody asked to move, and touching a change that sits in a merge
 * queue ejects it along with everything batched with it. When the
 * answer is no, the refusal carries what to do instead, because a
 * caller told only that something is unsupported has to go and read a
 * CLI's help to find the door that is open.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type {
	AuthoringIntent,
	BoundTarget,
	CheckoutFacts,
	FieldEdit,
	Proposal,
} from "../../../lib/review/index.js";
import { fillProposal, offerable } from "../../../lib/review/index.js";
import { proposalComplaint } from "../conventions.js";
import { confirmWrite } from "../gate.js";
import { GLYPH, proposalLine } from "../render.js";
import {
	type Answer,
	boundFor,
	hostedChange,
	messageOf,
	refuse,
	renderAnswer,
	renderInvocation,
	say,
} from "./shared.js";

/** What the tool was asked to do. */
interface OfferParams {
	action:
		| "propose"
		| "edit"
		| "ready"
		| "unready"
		| "close"
		| "reopen"
		| "merge"
		| "reviewers";
	change?: string;
	repo?: string;
	base?: string;
	head?: string;
	title?: string;
	body?: string;
	draft?: boolean;
	comment?: string;
	method?: string;
	expectedHead?: string;
	reviewers?: string[];
	clear?: string[];
}

/** Which authoring intent an action amounts to. */
const INTENT: Record<OfferParams["action"], AuthoringIntent["kind"]> = {
	propose: "propose",
	edit: "retarget",
	ready: "set-draft",
	unready: "set-draft",
	close: "close",
	reopen: "reopen",
	merge: "merge",
	reviewers: "request-reviewers",
};

/** Register the `review_offer` tool. */
export function registerOfferTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review_offer",
		label: "Review Offer",
		description:
			"Put work up for review and move it along: propose a change from a branch, edit its title, body or base, move it between draft and ready, ask people to look at it, close or reopen it, and merge it. Reading a change is review_see.",
		promptSnippet:
			"Put work up for review: propose, edit, ready, draft, reviewers, close, reopen, merge.",
		promptGuidelines: [
			"Say whether a new change is a draft. It is required, because the backends disagree about what silence means and the same call otherwise produces a live change on one and an invisible one on the other.",
			"Proposing takes the head, base, title and body from the checkout when you do not name them, and the gate names everything it took. Read that line back rather than approving past it.",
			"When an action is refused, pass on what it says to do instead rather than reporting a generic failure. The refusal names the door that is open.",
			"Never retarget, ready or draft a change that is queued to merge without saying what that costs: on a queue-backed backend it ejects the change and everything batched with it.",
			"Every action here opens a confirmation gate, so describe what you are about to do before calling it.",
		],
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("propose"),
					Type.Literal("edit"),
					Type.Literal("ready"),
					Type.Literal("unready"),
					Type.Literal("close"),
					Type.Literal("reopen"),
					Type.Literal("merge"),
					Type.Literal("reviewers"),
				],
				{
					description:
						"What to do. propose: put a branch up as a change. edit: change its title, body or base. ready: mark it ready for review; unready: put it back to a draft. reviewers: ask people to look. close and reopen. merge: land it.",
				},
			),
			change: Type.Optional(
				Type.String({
					description: "The hosted change. Omit to act on the attached change.",
				}),
			),
			repo: Type.Optional(
				Type.String({ description: "Checkout path, for propose." }),
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
			title: Type.Optional(
				Type.String({
					description:
						"Title. For propose, defaults to the last commit's subject.",
				}),
			),
			body: Type.Optional(Type.String({ description: "Description." })),
			draft: Type.Optional(
				Type.Boolean({
					description:
						"For propose: whether it opens as a draft. Required for propose, since the backends default opposite ways.",
				}),
			),
			comment: Type.Optional(
				Type.String({ description: "For close: why, said on the change." }),
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
			reviewers: Type.Optional(
				Type.Array(Type.String(), {
					description: "For reviewers: who to ask.",
				}),
			),
			clear: Type.Optional(
				Type.Array(Type.String(), {
					description: "For edit: fields to empty, e.g. body.",
				}),
			),
		}),

		renderCall(args, theme) {
			const params = args as { action?: string; change?: string };
			return renderInvocation(
				theme,
				"review_offer",
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
				const authoring = bound.provider.authoring;

				// Asked before anything is sent, and asked of this repo
				// rather than of the provider in general, since a provider
				// can be able to do something everywhere but here.
				const allowed = offerable(
					{
						kind: INTENT[params.action],
						...(params.action === "propose" && params.reviewers?.length
							? { withReviewers: true }
							: {}),
					},
					bound.capabilities.authoring,
					bound.provider.id,
				);
				if (!allowed.ok) {
					return refuse(
						allowed.instead
							? `${allowed.reason}\n\n${allowed.instead}`
							: allowed.reason,
					);
				}
				if (!authoring) {
					return refuse(
						`The ${bound.provider.id} provider says it can author changes but exposes no way to, which is a bug in that provider rather than in what you asked.`,
					);
				}

				// Whatever text is about to become a proposal is held to the
				// same conventions the guardian enforces on `gh pr create`.
				// Without this, authoring through a tool is a way around
				// every rule the shell path cannot be talked past.
				if (params.action === "propose" || params.action === "edit") {
					const complaint = proposalComplaint(params.title, params.body);
					if (complaint) return refuse(complaint);
				}

				if (params.action === "propose") {
					return propose(pi, ctx, bound, authoring, params);
				}

				const change = hostedChange(bound);
				if (!change) {
					return refuse(
						"Nothing hosts this target, so there is no change to act on. Propose it first.",
					);
				}

				switch (params.action) {
					case "edit":
						return edit(ctx, change, authoring, params);
					case "ready":
					case "unready": {
						const wanted = params.action === "unready";
						const approved = await confirmWrite(
							ctx,
							`Move ${change.label} to ${wanted ? "draft" : "ready"}?`,
							`${GLYPH.target} ${change.label}`,
						);
						if (!approved) return say("Left as it was.");
						await authoring.setDraft?.(change, wanted);
						return say(
							`${GLYPH.lands} ${change.label} is now ${wanted ? "a draft" : "ready for review"}.`,
						);
					}
					case "close": {
						const approved = await confirmWrite(
							ctx,
							`Close ${change.label}?`,
							[
								`${GLYPH.target} ${change.label}`,
								params.comment
									? `\n${params.comment}`
									: "\nNo reason will be left on it, which reads as abandonment.",
							].join("\n"),
						);
						if (!approved) return say("Left open.");
						await authoring.close(
							change,
							...(params.comment === undefined ? [] : [params.comment]),
						);
						return say(`${GLYPH.lands} ${change.label} closed.`);
					}
					case "reopen": {
						const approved = await confirmWrite(
							ctx,
							`Reopen ${change.label}?`,
							`${GLYPH.target} ${change.label}`,
						);
						if (!approved) return say("Left closed.");
						await authoring.reopen?.(change);
						return say(`${GLYPH.lands} ${change.label} reopened.`);
					}
					case "merge":
						return merge(ctx, change, authoring, params);
					case "reviewers":
						return reviewers(ctx, change, authoring, params);
				}
			} catch (error) {
				return refuse(messageOf(error));
			}
		},
	});
}

/**
 * What the checkout can tell us, for filling a proposal in.
 *
 * Every read is allowed to fail. A detached head has no branch, a repo
 * with no origin has no trunk, and a fresh repo has no commit; each of
 * those is a fact rather than an error, and `fillProposal` decides
 * which ones it can live without.
 */
async function checkoutFacts(
	pi: ExtensionAPI,
	cwd: string,
): Promise<CheckoutFacts> {
	const git = async (...args: string[]): Promise<string | undefined> => {
		try {
			const result = await pi.exec("git", ["-C", cwd, ...args]);
			const out = result.stdout.trim();
			return result.code === 0 && out !== "" ? out : undefined;
		} catch {
			// Not a repo, or git is not here. Either way there is nothing
			// to learn, and the caller says what it needed.
			return undefined;
		}
	};

	const [branch, originHead, subject, body, status] = await Promise.all([
		git("rev-parse", "--abbrev-ref", "HEAD"),
		git("symbolic-ref", "--short", "refs/remotes/origin/HEAD"),
		git("log", "-1", "--format=%s"),
		git("log", "-1", "--format=%b"),
		git("status", "--porcelain"),
	]);

	return {
		// A detached head reports the literal word HEAD, which is not a
		// branch anybody can push.
		...(branch !== undefined && branch !== "HEAD" ? { branch } : {}),
		...(originHead === undefined
			? {}
			: { trunk: originHead.replace(/^origin\//, "") }),
		...(subject === undefined ? {} : { subject }),
		...(body === undefined ? {} : { bodyFromCommits: body }),
		...(status === undefined ? {} : { dirty: true }),
	};
}

/** Put a branch up as a change. */
async function propose(
	pi: ExtensionAPI,
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	bound: BoundTarget,
	authoring: NonNullable<BoundTarget["provider"]["authoring"]>,
	params: OfferParams,
): Promise<Answer> {
	if (params.draft === undefined) {
		// Not defaulted, on purpose, and not guessable from the checkout
		// either. One backend opens a new change ready and another opens
		// it as a draft, so guessing means the same call produces a live
		// change on one and an invisible one on the other, and the caller
		// finds out from a surprised reviewer or from a change nobody ever
		// looked at.
		return refuse(
			"Say whether this opens as a draft. It is not defaulted, because the backends disagree about what silence means: one opens a new change ready and another opens it as a draft.",
		);
	}

	// Everything else the checkout already knows. Guessing is safe here
	// because the gate below shows every guess to a person before
	// anything is sent, which is exactly what a provider inferring the
	// same things could not promise.
	const filled = fillProposal(
		{
			...(params.base === undefined ? {} : { base: params.base }),
			...(params.head === undefined ? {} : { head: params.head }),
			...(params.title === undefined ? {} : { title: params.title }),
			...(params.body === undefined ? {} : { body: params.body }),
		},
		await checkoutFacts(pi, params.repo ?? process.cwd()),
	);
	if ("refusal" in filled) return refuse(filled.refusal);
	const { base, head, title, body, guessed, warnings } = filled.fill;

	const approved = await confirmWrite(
		ctx,
		`Propose ${head} onto ${base}?`,
		[
			`${GLYPH.target} ${title}${params.draft ? " (draft)" : ""}`,
			`   ${head} → ${base}`,
			...(body ? ["", body] : []),
			...(params.reviewers?.length
				? ["", `Asking: ${params.reviewers.join(", ")}`]
				: []),
			// Named rather than merely used, so a wrong guess is caught
			// here by the one person who can tell.
			...(guessed.length === 0
				? []
				: ["", `Taken from the checkout: ${guessed.join(", ")}.`]),
			...warnings.map((warning) => `\n${GLYPH.refused} ${warning}`),
		].join("\n"),
	);
	if (!approved) return say("Not proposed.");

	const made: Proposal = await authoring.propose({
		repo: bound.repo,
		base,
		head,
		title,
		body,
		draft: params.draft,
	});

	// Reviewers after the change exists, since there is nothing to ask
	// anyone to look at before that. A failure here leaves a real change
	// behind, so it is reported rather than thrown: losing the change
	// because the ask failed would be the worse trade.
	let asking = "";
	if (params.reviewers?.length) {
		try {
			await authoring.requestReviewers?.(made.ref, params.reviewers);
			asking = `\n   asked ${params.reviewers.join(", ")}`;
		} catch (error) {
			asking = `\n   ${GLYPH.refused} the change is up, but asking ${params.reviewers.join(", ")} failed: ${messageOf(error)}`;
		}
	}

	return say(`${GLYPH.lands} ${proposalLine(made)}${asking}`, {
		ok: true,
		change: made.ref.label,
		url: made.url,
	});
}

/** Change a title, a body or a base. */
async function edit(
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	change: NonNullable<ReturnType<typeof hostedChange>>,
	authoring: NonNullable<BoundTarget["provider"]["authoring"]>,
	params: OfferParams,
): Promise<Answer> {
	const clearing = new Set(params.clear ?? []);
	const set = <T>(
		value: T | undefined,
		field: string,
	): FieldEdit<T> | undefined => {
		if (clearing.has(field)) return { action: "clear" };
		return value === undefined ? undefined : { action: "set", value };
	};

	const edits = {
		...(set(params.title, "title")
			? { title: set(params.title, "title") }
			: {}),
		...(set(params.body, "body") ? { body: set(params.body, "body") } : {}),
		...(set(params.base, "base") ? { base: set(params.base, "base") } : {}),
	};
	if (Object.keys(edits).length === 0) {
		return refuse(
			"Editing needs something to change: a title, a body, a base, or a field to clear.",
		);
	}

	const approved = await confirmWrite(
		ctx,
		`Edit ${change.label}?`,
		Object.entries(edits)
			.map(([field, edit]) =>
				edit?.action === "clear"
					? `${field}: cleared`
					: `${field}: ${String(edit?.value).slice(0, 200)}`,
			)
			.join("\n"),
	);
	if (!approved) return say("Left as it was.");

	const after = await authoring.edit(change, edits);
	return say(`${GLYPH.lands} ${proposalLine(after)}`);
}

/** Land the change. */
async function merge(
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	change: NonNullable<ReturnType<typeof hostedChange>>,
	authoring: NonNullable<BoundTarget["provider"]["authoring"]>,
	params: OfferParams,
): Promise<Answer> {
	const approved = await confirmWrite(
		ctx,
		`Merge ${change.label}?`,
		[
			`${GLYPH.target} ${change.label}`,
			params.method ? `   ${params.method}` : "   the repo's own merge policy",
			params.expectedHead
				? `   only if the head is still ${params.expectedHead}`
				: `   ${GLYPH.refused} unguarded: this merges whatever the head is now, including work pushed since you last looked`,
		].join("\n"),
	);
	if (!approved) return say("Not merged.");

	await authoring.merge(change, {
		...(params.method === undefined ? {} : { method: params.method }),
		...(params.expectedHead === undefined
			? {}
			: { expectedHead: params.expectedHead }),
	});
	return say(`${GLYPH.lands} ${change.label} merged.`);
}

/** Ask people to look. */
async function reviewers(
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	change: NonNullable<ReturnType<typeof hostedChange>>,
	authoring: NonNullable<BoundTarget["provider"]["authoring"]>,
	params: OfferParams,
): Promise<Answer> {
	const asking = params.reviewers ?? [];
	if (asking.length === 0) {
		return refuse("Asking for reviewers needs somebody to ask.");
	}

	const approved = await confirmWrite(
		ctx,
		`Ask ${asking.join(", ")} to review ${change.label}?`,
		`${GLYPH.target} ${change.label}`,
	);
	if (!approved) return say("Nobody was asked.");

	await authoring.requestReviewers?.(change, asking);
	return say(`${GLYPH.lands} asked ${asking.join(", ")}.`);
}
