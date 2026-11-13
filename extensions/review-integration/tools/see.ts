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
 *
 * What a call does, loaded on its first call; the registration is
 * `see-tool.ts`.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { citeListing } from "../../../lib/core/result/listing.ts";
import { openSessionStore } from "../../../lib/core/result/location.ts";
import {
	byRoundNewestFirst,
	type FindingRound,
} from "../../../lib/core/review/finding.ts";
import type {
	BoundTarget,
	Decision,
	Finding,
	ReviewTarget,
} from "../../../lib/core/review/index.ts";
import {
	createDecisionLedger,
	createFindingStore,
	createFixQueue,
	createVisitLog,
	describeAnchor,
	describeVisit,
	followUpOn,
	type QueuedFix,
	reactableAddresses,
	reactables,
	sinceLastVisit,
	tallyReceptions,
} from "../../../lib/core/review/index.ts";
import { count } from "../../../lib/ui/count.ts";
import {
	CHECKS_POLL_MS,
	type ChecksReading,
	unsettled,
	watchChecks,
} from "../checks-job.ts";
import { REVIEW_COMMANDS } from "../commands.ts";
import { decisionDir, findingDir, fixDir, visitDir } from "../engine.ts";
import {
	checksLines,
	GLYPH,
	proposalLine,
	stackLines,
	threadLines,
} from "../render.ts";
import type { SeeParams } from "./see-tool.ts";
import {
	type Answer,
	boundFor,
	boundForTarget,
	checkoutElsewhere,
	hostedChange,
	refuse,
	refuseFailure,
	repoToList,
	reviewedChange,
	say,
	type TargetParams,
	threadsOf,
} from "./shared.ts";

/**
 * How a watch a move carried in reads its change's checks, once the
 * change is bound here; nothing when it can't be.
 */
export async function checksReading(
	pi: ExtensionAPI,
	target: ReviewTarget,
): Promise<ChecksReading | undefined> {
	const bound = await boundForTarget(pi, target);
	return bound
		? { read: () => bound.checks(), render: checksLines }
		: undefined;
}

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
	| "findings"
	| "followup";

/** Do what a `review_see` call asks, once the tool is first called. */
export async function runSee(
	pi: ExtensionAPI,
	params: SeeParams,
	ctx: ExtensionContext,
): Promise<Answer> {
	// Held outside the try so a failure can say which provider was asked.
	let bound: BoundTarget | undefined;
	try {
		// Siblings are the one read that is about a repo rather
		// than a change, so it resolves differently.
		if (params.action === "changes") return seeChanges(pi, params, ctx);

		bound = await boundFor(pi, params, ctx.cwd);
		if (params.action === "checks" && params.watch === true)
			return await watchFor(pi, bound, ctx);
		return await readFrom(
			bound,
			params.action as Exclude<SeeAction, "changes">,
			(params as { mine?: boolean }).mine === true,
			ctx,
		);
	} catch (error) {
		return refuseFailure(error, bound);
	}
}

/** Dispatch one read against an already-bound change. */
/**
 * One review as a line: who, what they decided, and the first thing they said.
 *
 * A verdict with no words is a real thing to leave, and this used to render it as
 * a line of three spaces, because the first line of an empty body is an empty
 * string. It read as a body that had failed to load rather than one that was
 * never written, and those want telling apart. Saying so out loud is the whole
 * difference between an absence and a bug.
 *
 * Exported to be testable. It was unreachable from a test while it lived inside
 * the tool's execute, which is why nobody noticed the blank line for so long.
 */
export function reviewLine(review: {
	author: { id: string };
	verdict: string;
	body: string;
}): string {
	const head = `${GLYPH.verdict} ${review.author.id} · ${review.verdict}`;
	// The first line with something on it, so a body that opens with a blank line
	// still reports what it says rather than reporting nothing.
	const first = review.body.split("\n").find((one) => one.trim() !== "");
	return first === undefined ? `${head} · no comment` : `${head}\n   ${first}`;
}

async function readFrom(
	bound: BoundTarget,
	action: Exclude<SeeAction, "changes">,
	mine: boolean,
	ctx: ExtensionContext,
): Promise<Answer> {
	if (action === "change") return seeChange(bound);
	if (action === "diff") return seeDiff(bound, ctx);
	if (action === "checks") return seeChecks(bound);
	if (action === "stack") return seeStack(bound);
	if (action === "findings") return seeFindings(bound, ctx);
	return seeConversation(bound, action, mine, ctx);
}

/** The change itself, with its body. */
async function seeChange(bound: BoundTarget): Promise<Answer> {
	const proposal = await bound.proposal();
	if (!proposal) {
		return say(
			`${GLYPH.target} a ${bound.target.kind} in ${bound.repo.key}, which nothing hosts. Review it and render the result.`,
		);
	}
	// Whether you have been here before, said before the body rather than after
	// it. A change that has moved since you reviewed it is the thing to know
	// first, not a footnote under two hundred lines of description.
	const change = hostedChange(bound);
	const visited =
		change === undefined
			? undefined
			: sinceLastVisit(createVisitLog(visitDir()).last(change), proposal);
	const note =
		visited === undefined || visited.kind === "never"
			? undefined
			: `${visited.kind === "moved" ? GLYPH.finding : GLYPH.lands} ${describeVisit(visited)}`;
	return say(
		[proposalLine(proposal), ...(note ? [note] : []), "", proposal.body].join(
			"\n",
		),
		{ ok: true, ...(visited === undefined ? {} : { since: visited.kind }) },
	);
}

/** The whole diff, stored so a big one stays reachable. */
async function seeDiff(
	bound: BoundTarget,
	ctx: ExtensionContext,
): Promise<Answer> {
	const diff = await bound.diff();
	const model = await bound.diffModel();
	return say(
		citeListing(openSessionStore(ctx), {
			view: diff,
			records: model.files,
			unit: "files",
			narrowing: "Query the stored result for the files or hunks you need.",
		}),
		{
			ok: true,
			files: model.files.length,
			summary: `${GLYPH.target} ${count(model.files.length, "file", "files")}`,
		},
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

/**
 * What CI says now, and when it has not settled, a job that says it
 * once it has. Settled already, this answers as a plain read does.
 */
async function watchFor(
	pi: ExtensionAPI,
	bound: BoundTarget,
	ctx: ExtensionContext,
): Promise<Answer> {
	const checks = await bound.checks();
	if (!checks) {
		return say(
			`${GLYPH.checks} the ${bound.provider.id} provider reports no checks for this target, so there is nothing to watch.`,
		);
	}
	const now = checksLines(checks);
	if (!unsettled(checks)) return say(now, { ok: true, state: checks.state });

	const label =
		bound.target.kind === "change"
			? bound.target.change.label
			: `${bound.target.kind} in ${bound.repo.key}`;
	const watched = watchChecks({
		bus: pi.events,
		session: ctx,
		key: `${bound.provider.id}:${label}`,
		label,
		target: bound.target,
		read: () => bound.checks(),
		render: checksLines,
	});
	const after =
		watched === "no-host"
			? "Nothing can watch them here, since no job host is loaded; read checks again later."
			: watched === "already-watching"
				? "They are already being watched; the settled result will arrive as its own message."
				: `Watching: they are looked at every ${CHECKS_POLL_MS / 1000} seconds, for two hours at most, and the settled result will arrive as its own message. Carry on with other work; do not poll or sleep for them.`;
	return say(`${now}\n${after}`, {
		ok: true,
		state: checks.state,
		watching: typeof watched !== "string" || watched === "already-watching",
	});
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

/** Threads, reviews, messages or your own follow-up, from whatever hosts it. */
async function seeConversation(
	bound: BoundTarget,
	action: "threads" | "reviews" | "messages" | "followup",
	mine: boolean,
	ctx: ExtensionContext,
): Promise<Answer> {
	const conversation = bound.conversation;
	const change = hostedChange(bound);
	if (!conversation || !change) {
		return refuse(
			"Nothing hosts this target, so it has no conversation. Compose a review with review_draft and render it as a document.",
		);
	}

	if (action === "followup") {
		if (conversation.viewer === undefined) {
			// Refused rather than guessed. Matching a display name attributes
			// somebody else's remark to you eventually, and taking the most
			// recent reviewer assumes you are whoever spoke last.
			return refuse(
				`${GLYPH.refused} The ${bound.provider.id} provider cannot say who you are, so it cannot tell which remarks are yours. Read the threads instead and judge them yourself.`,
			);
		}
		const viewer = await conversation.viewer(bound.repo);
		const found = followUpOn(await threadsOf(bound), viewer);
		if (found.length === 0) {
			return say(
				`${GLYPH.finding} You have not remarked on this change, so there is nothing of yours to follow up.`,
				{ ok: true, followups: [] },
			);
		}
		const counted = tallyReceptions(found);
		const quiet = counted["resolved-quietly"] ?? 0;
		return say(
			citeListing(openSessionStore(ctx), {
				view: [
					`${GLYPH.finding} ${found.length} of your ${found.length === 1 ? "thread" : "threads"} on this change, as ${viewer.name ?? viewer.id}`,
					...(quiet > 0
						? [
								// Careful wording. This does not know the code is
								// unchanged, and saying so would accuse an author
								// who fixed it on a backend that reports no
								// staleness at all.
								`   ${quiet} ${quiet === 1 ? "was" : "were"} closed without a word. Worth re-reading.`,
							]
						: []),
					"",
					...found.map(
						(one, index) =>
							`[T${index + 1}] ${one.reception === "resolved-quietly" ? GLYPH.refused : GLYPH.finding} ${
								one.thread.anchor === undefined
									? "the change as a whole"
									: describeAnchor(one.thread.anchor)
							}\n   ${one.reception} · ${one.because}`,
					),
				].join("\n"),
				records: found,
				unit: "followups",
				narrowing:
					"Query the stored result for a thread's full exchange, or read threads for everybody's.",
			}),
			{ ok: true, followups: found, viewer, counted },
		);
	}

	if (action === "threads") {
		const threads = await threadsOf(bound);
		// Each remark carries the address a reaction is aimed by. Computed
		// from the threads alone, which is enough: the address says which
		// family it belongs to, so these are the same numbers whatever else
		// of the conversation a later call happens to be holding.
		const addresses = reactableAddresses(reactables({ threads }));
		return say(
			citeListing(openSessionStore(ctx), {
				view:
					threads
						.map((t, index) => threadLines(t, index, addresses))
						.join("\n") || "No threads yet.",
				records: threads,
				unit: "threads",
				narrowing: "Query the stored result for a thread's full exchange.",
			}),
			{
				ok: true,
				count: threads.length,
				summary: `${GLYPH.thread} ${count(threads.length, "thread", "threads")}`,
			},
		);
	}

	if (action === "reviews") {
		const all = await conversation.reviews(change);
		// Whose reviews to show. Narrowing to your own needs the backend to say
		// who you are, and a backend that will not is told so rather than
		// silently showing everybody's under a heading that says mine.
		let reviews = all;
		let whose = "";
		if (mine) {
			if (conversation.viewer === undefined) {
				return refuse(
					`${GLYPH.refused} The ${bound.provider.id} provider cannot say who you are, so it cannot pick out your reviews. Read them all and look for your own name.`,
				);
			}
			const viewer = await conversation.viewer(bound.repo);
			reviews = all.filter((review) => review.author.id === viewer.id);
			whose = ` by ${viewer.name ?? viewer.id}`;
		}
		return say(
			citeListing(openSessionStore(ctx), {
				view:
					reviews.map(reviewLine).join("\n") ||
					(mine
						? `No reviews${whose} yet, though there are ${all.length} from other people.`
						: "No reviews yet."),
				records: reviews,
				unit: "reviews",
				narrowing: "Query the stored result for a review's full body.",
			}),
			{
				ok: true,
				count: reviews.length,
				summary: `${GLYPH.verdict} ${count(reviews.length, "review", "reviews")}`,
			},
		);
	}

	const messages = await conversation.messages(change);
	const said = reactables({ messages });
	return say(
		citeListing(openSessionStore(ctx), {
			view:
				said
					.map(
						(one) =>
							`${one.label} ${one.message.author.id}: ${one.message.body}`,
					)
					.join("\n\n") || "No messages yet.",
			records: messages,
			unit: "messages",
			narrowing: "Query the stored result for the rest.",
		}),
		{
			ok: true,
			count: messages.length,
			summary: `${GLYPH.document} ${count(messages.length, "message", "messages")}`,
		},
	);
}

/**
 * What a review pass raised, before any of it is said out loud.
 *
 * Findings are not remarks. Nobody has seen these but you, which
 * is why they are read here and curated in `review_draft` rather
 * than appearing in the conversation.
 */
async function seeFindings(
	bound: BoundTarget,
	ctx: ExtensionContext,
): Promise<Answer> {
	const change = reviewedChange(bound);
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

	// The newest round first, under a line naming it, so a budget that cuts
	// the listing cuts the oldest rounds, never the one just run.
	const rounds = byRoundNewestFirst(findings);
	const newestFirst = rounds.flatMap((round) => round.findings);
	const view = rounds
		.map((round, at) =>
			[
				roundLine(round, at === 0),
				...round.findings.map((finding) =>
					findingLine(finding, queued.get(finding.id), decided.get(finding.id)),
				),
			].join("\n"),
		)
		.join("\n\n");
	return say(
		citeListing(openSessionStore(ctx), {
			view,
			records: newestFirst,
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

/** The line naming a round above its findings. */
function roundLine(round: FindingRound, newest: boolean): string {
	const ids = round.findings.map((finding) => finding.id);
	const span =
		ids.length === 1
			? `F${ids[0]}`
			: `F${Math.min(...ids)} to F${Math.max(...ids)}`;
	const name = round.runId ?? "written by hand";
	return `${newest ? "Newest round" : "Earlier round"}: ${name}, ${count(ids.length, "finding", "findings")} (${span})`;
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
					: queued.outcome.kind === "answered"
						? " · answered"
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
	ctx: ExtensionContext,
): Promise<Answer> {
	const cwd = params.repo ?? ctx.cwd;
	// A change when there is one, and otherwise the checkout itself.
	// The attached change counts here like it does everywhere else,
	// which is why this goes through the shared resolution at all; but
	// a change is how this surface usually names a repo, not the only
	// way, and insisting on one refused the caller who named the very
	// thing the action is about.
	const bound = await repoToList(pi, params, cwd);

	// Naming a repo and being answered about another one is the failure
	// this guards. Resolution prefers the change in play, which is right
	// nearly everywhere and wrong here: listing is the one action whose
	// whole subject is the repo, so an explicitly named repo that
	// disagrees with the attachment is a contradiction rather than a
	// detail. Only checked when the caller named one, since falling back
	// to the attachment's repo is the documented convenience.
	if (params.repo && bound.bound) {
		const apart = await checkoutElsewhere(
			REVIEW_COMMANDS,
			params.repo,
			bound.bound,
		);
		if (apart) {
			return refuse(
				`You named ${apart.checkout}, and the change in play is on ${apart.repo}, so this would list ${apart.repo} instead. Detach that change, or name a change in ${apart.checkout}.`,
			);
		}
	}

	const lister = bound.provider.changes?.list;
	if (!lister) {
		return refuse(
			`The ${bound.provider.id} provider cannot list the changes in a repo, so there is nothing to show. Read one change at a time instead.`,
		);
	}
	const found = await lister(bound.repo, {
		...(params.state ? { state: params.state } : {}),
		...(params.limit !== undefined ? { limit: params.limit } : {}),
	});
	// The repo is named in the headline because it was not always the
	// one asked for: with a change attached, resolution answers about
	// that change's repo, and every row here reads the same whichever
	// repo it came from.
	if (found.length === 0) {
		return say(`${GLYPH.target} no changes match in ${bound.repo.key}.`);
	}
	return say(
		citeListing(openSessionStore(ctx), {
			view: [
				`${GLYPH.target} ${bound.repo.key}`,
				"",
				found.map(proposalLine).join("\n\n"),
			].join("\n"),
			records: found,
			unit: "changes",
			narrowing: "Narrow with 'state', or lower 'limit'.",
		}),
		{
			ok: true,
			count: found.length,
			summary: `${GLYPH.target} ${count(found.length, "change", "changes")}`,
		},
	);
}
