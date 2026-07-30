/**
 * The `review_see` tool: everything reading a change can tell you.
 *
 * One tool because the intent is one intent. Someone finding out
 * about a change wants its body, then its diff, then what people
 * said about it, and asking three differently-named tools for
 * those made the split a quiz about which subject owned which
 * question. The subject is always the change; what varies is what
 * you want to know.
 *
 * Read-only, so no gate anywhere in here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { citeListing, openSessionStore } from "../../../lib/result/index.js";
import type {
	BoundTarget,
	Decision,
	Finding,
} from "../../../lib/review/index.js";
import {
	createDecisionLedger,
	createFindingStore,
	createFixQueue,
	describeAnchor,
	type QueuedFix,
} from "../../../lib/review/index.js";
import { decisionDir, findingDir, fixDir, reviewEngine } from "../engine.js";
import {
	checksLines,
	GLYPH,
	proposalLine,
	stackLines,
	threadLines,
} from "../render.js";
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
	threadsOf,
} from "./shared.js";

/** What `review_see` can be asked for. */
type SeeAction =
	| "change"
	| "diff"
	| "checks"
	| "stack"
	| "changes"
	| "threads"
	| "reviews"
	| "messages"
	| "findings";

/** Register the `review_see` tool. */
export function registerSeeTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review_see",
		label: "Review See",
		description:
			"Read a change under review, whatever hosts it: the change itself, its diff, its checks, the stack it sits in, sibling changes in the repo, and the conversation on it as threads, reviews or plain messages. Works for hosted changes and for local ranges and stacks that nothing hosts.",
		promptSnippet:
			"Read a change under review: the change, its diff, checks, stack, sibling changes, and its conversation.",
		promptGuidelines: [
			"Leave the change out to read whatever is attached. Name one to read something else without disturbing the attachment.",
			"A change can be a URL, an owner/repo#number short form or a bare number; or pass base and head, or refs, to read something nobody has proposed.",
			"Never assume GitHub. The provider is resolved from config, then provider claims, then the reference's shape.",
			"A derived stack can be wrong at the edges: a merged parent or a renamed branch ends the chain early. Pass that caveat on when it matters.",
			"When a stack or a capability is missing, say which provider was asked rather than reporting a generic failure.",
			"Refer to a thread by the [T#] index the threads listing shows. Never invent or guess one.",
		],
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("change"),
					Type.Literal("diff"),
					Type.Literal("checks"),
					Type.Literal("stack"),
					Type.Literal("changes"),
					Type.Literal("threads"),
					Type.Literal("reviews"),
					Type.Literal("messages"),
					Type.Literal("findings"),
				],
				{
					description:
						"What to read. change: the proposal and its body. diff: the whole diff. checks: what CI says. stack: what it sits on, with provenance. changes: siblings in the repo. threads: anchored conversation, numbered. reviews: verdicts people left. messages: top-level remarks. findings: what a review pass raised, not yet said to anybody.",
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
				Type.Union(
					[
						Type.Literal("open"),
						Type.Literal("merged"),
						Type.Literal("closed"),
					],
					{ description: "For changes: which ones." },
				),
			),
			limit: Type.Optional(
				Type.Number({ description: "For changes: how many." }),
			),
		}),

		renderCall(args, theme) {
			const params = args as { action?: string; change?: string };
			return renderInvocation(
				theme,
				"review_see",
				params.action,
				params.change,
			);
		},

		renderResult(result, _state, theme) {
			return renderAnswer(result, theme);
		},

		async execute(_id, params): Promise<Answer> {
			try {
				// Siblings are the one read that is about a repo rather
				// than a change, so it resolves differently.
				if (params.action === "changes") return seeChanges(pi, params);

				const bound = await boundFor(pi, params, process.cwd());
				return await readFrom(
					bound,
					params.action as Exclude<SeeAction, "changes">,
				);
			} catch (error) {
				return refuse(messageOf(error));
			}
		},
	});
}

/** Dispatch one read against an already-bound change. */
async function readFrom(
	bound: BoundTarget,
	action: Exclude<SeeAction, "changes">,
): Promise<Answer> {
	if (action === "change") return seeChange(bound);
	if (action === "diff") return seeDiff(bound);
	if (action === "checks") return seeChecks(bound);
	if (action === "stack") return seeStack(bound);
	if (action === "findings") return seeFindings(bound);
	return seeConversation(bound, action);
}

/** The change itself, with its body. */
async function seeChange(bound: BoundTarget): Promise<Answer> {
	const proposal = await bound.proposal();
	if (!proposal) {
		return say(
			`${GLYPH.target} a ${bound.target.kind} in ${bound.repo.key}, which nothing hosts. Review it and render the result.`,
		);
	}
	return say(`${proposalLine(proposal)}\n\n${proposal.body}`);
}

/** The whole diff, stored so a big one stays reachable. */
async function seeDiff(bound: BoundTarget): Promise<Answer> {
	const diff = await bound.diff();
	const model = await bound.diffModel();
	return say(
		citeListing(openSessionStore(), {
			view: diff,
			records: model.files,
			unit: "files",
			narrowing: "Query the stored result for the files or hunks you need.",
		}),
		{ ok: true, files: model.files.length },
	);
}

/** What CI says, with unreported kept apart from failed. */
async function seeChecks(bound: BoundTarget): Promise<Answer> {
	const checks = await bound.checks();
	if (!checks) {
		return say(
			`${GLYPH.checks} the ${bound.provider.id} provider reports no checks for this target.`,
		);
	}
	return say(checksLines(checks), { ok: true, state: checks.state });
}

/** What the change sits on, and how much to trust the shape. */
async function seeStack(bound: BoundTarget): Promise<Answer> {
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
}

/** Threads, reviews or messages, from whatever hosts the change. */
async function seeConversation(
	bound: BoundTarget,
	action: "threads" | "reviews" | "messages",
): Promise<Answer> {
	const conversation = bound.conversation;
	const change = hostedChange(bound);
	if (!conversation || !change) {
		return refuse(
			"Nothing hosts this target, so it has no conversation. Compose a review with review_draft and render it as a document.",
		);
	}

	if (action === "threads") {
		const threads = await threadsOf(bound);
		return say(
			citeListing(openSessionStore(), {
				view:
					threads.map((t, index) => threadLines(t, index)).join("\n") ||
					"No threads yet.",
				records: threads,
				unit: "threads",
				narrowing: "Query the stored result for a thread's full exchange.",
			}),
			{ ok: true, count: threads.length },
		);
	}

	if (action === "reviews") {
		const reviews = await conversation.reviews(change);
		return say(
			citeListing(openSessionStore(), {
				view:
					reviews
						.map(
							(review) =>
								`${GLYPH.verdict} ${review.author.id} · ${review.verdict}\n   ${review.body.split("\n")[0] ?? ""}`,
						)
						.join("\n") || "No reviews yet.",
				records: reviews,
				unit: "reviews",
				narrowing: "Query the stored result for a review's full body.",
			}),
			{ ok: true, count: reviews.length },
		);
	}

	const messages = await conversation.messages(change);
	return say(
		citeListing(openSessionStore(), {
			view:
				messages.map((m) => `${m.author.id}: ${m.body}`).join("\n\n") ||
				"No messages yet.",
			records: messages,
			unit: "messages",
			narrowing: "Query the stored result for the rest.",
		}),
		{ ok: true, count: messages.length },
	);
}

/**
 * What a review pass raised, before any of it is said out loud.
 *
 * Findings are not remarks. Nobody has seen these but you, which
 * is why they are read here and curated in `review_draft` rather
 * than appearing in the conversation.
 */
async function seeFindings(bound: BoundTarget): Promise<Answer> {
	const change = hostedChange(bound);
	if (!change) {
		return refuse(
			`A ${bound.target.kind} in ${bound.repo.key} is not something findings are held against, since there is no change to hold them on.`,
		);
	}
	const findings = await createFindingStore(findingDir()).list(change);
	if (findings.length === 0) {
		return say(`${GLYPH.finding} nothing raised on ${change.label} yet.`, {
			ok: true,
			count: 0,
		});
	}
	// What is already queued to fix, so a reader can tell settled from
	// undecided. Without it the list looks the same before and after
	// deciding, and the only thing that says otherwise is the error you
	// get from queueing something twice.
	const queued = new Map(
		(await createFixQueue(fixDir()).list(change)).map((one) => [
			one.findingId,
			one,
		]),
	);
	// The same for the other two verdicts. Promoting and dismissing leave
	// no mark on the finding either, so without this a finding already
	// dealt with reads exactly like one nobody has looked at.
	const decided = new Map(
		(await createDecisionLedger(decisionDir()).list(change)).map((one) => [
			one.findingId,
			one,
		]),
	);

	return say(
		citeListing(openSessionStore(), {
			view: findings
				.map((finding) =>
					findingLine(finding, queued.get(finding.id), decided.get(finding.id)),
				)
				.join("\n"),
			records: findings,
			unit: "findings",
			narrowing: "Query the stored result for a finding's full discussion.",
		}),
		{
			ok: true,
			count: findings.length,
			queued: queued.size,
			decided: decided.size,
		},
	);
}

/**
 * One finding, in a line somebody can scan.
 *
 * The number leads because that is how people refer to a finding
 * out loud, and the origin is named because a claim from one
 * reviewer and the same claim from three deserve different
 * weight.
 */
function findingLine(
	finding: Finding,
	queued?: QueuedFix,
	decided?: Decision,
): string {
	const where =
		finding.anchor.subject === "change"
			? "on the change"
			: describeAnchor(finding.anchor);
	const agreed =
		finding.raisedBy && finding.raisedBy.length > 1
			? ` · raised by ${finding.raisedBy.join(", ")}`
			: "";
	const from =
		finding.origin.kind === "hand"
			? "by hand"
			: `${finding.origin.kind} ${finding.origin.reviewerId}`;
	const severity = finding.severity ? ` · ${finding.severity}` : "";
	const fixing =
		queued === undefined
			? ""
			: queued.outcome === undefined
				? " · queued to fix"
				: queued.outcome.kind === "committed"
					? ` · fixed in ${queued.outcome.commit}`
					: ` · fix dropped: ${queued.outcome.reason}`;
	// A queued fix already says so above, so saying it twice would be
	// noise on the one line a reader scans.
	const settled =
		decided === undefined || decided.verdict === "fix"
			? ""
			: decided.verdict === "promote"
				? " · promoted into a draft"
				: " · dismissed";
	return `${GLYPH.finding} [F${finding.id}] ${finding.label}: ${finding.subject}\n     ${where} · ${from}${severity}${agreed}${fixing}${settled}`;
}

/**
 * Sibling changes in the same repo.
 *
 * This one needs a provider that lists, and it resolves from a
 * named change rather than the attachment, because the question
 * is about the repo the change lives in.
 */
async function seeChanges(
	pi: ExtensionAPI,
	params: TargetParams & {
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
	if (found.length === 0) return say(`${GLYPH.target} no changes match.`);
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
