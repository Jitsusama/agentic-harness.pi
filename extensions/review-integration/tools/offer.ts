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
import type { Exec } from "../../../lib/exec/index.js";
import type {
	AuthoringIntent,
	BoundTarget,
	CheckoutFacts,
	FieldEdit,
	Proposal,
	SetEdit,
} from "../../../lib/review/index.js";
import {
	fillProposal,
	misnamedPeople,
	offerable,
	retargetPlan,
	retargetRoute,
} from "../../../lib/review/index.js";
import { count } from "../../../lib/ui/index.js";
import { createGitRebaser, createGitStacks } from "../../../lib/work/index.js";
import { proposalComplaint } from "../conventions.js";
import { attachments } from "../engine.js";
import { confirmWrite } from "../gate.js";
import { type GatePanel, GLYPH, proposalLine } from "../render.js";
import {
	type Answer,
	boundFor,
	checkoutElsewhere,
	declined,
	hostedChange,
	messageOf,
	refuse,
	refuseFailure,
	renderAnswer,
	renderInvocation,
	say,
} from "./shared.js";

/** What the tool was asked to do. */
interface OfferParams {
	action:
		| "propose"
		| "propose-stack"
		| "edit"
		| "ready"
		| "unready"
		| "close"
		| "reopen"
		| "merge"
		| "reviewers"
		| "rerun"
		| "retarget-stack";
	change?: string;
	which?: string;
	repo?: string;
	base?: string;
	head?: string;
	heads?: string[];
	title?: string;
	body?: string;
	bodies?: string[];
	draft?: boolean;
	comment?: string;
	method?: string;
	expectedHead?: string;
	reviewers?: string[];
	labels?: string[];
	labelMode?: "add" | "set";
	unlabels?: string[];
	assignees?: string[];
	unassignees?: string[];
	clear?: string[];
}

/**
 * Actions whose intent a merge queue objects to.
 *
 * Named here so the queue is only fetched when the answer could change
 * what happens. Proposing has no change to be queued yet, and merging is
 * what a queue is for.
 */
const ASKS_THE_QUEUE: ReadonlySet<OfferParams["action"]> = new Set([
	"edit",
	"ready",
	"unready",
]);

/**
 * Which authoring intent an action amounts to.
 *
 * `edit` is the interesting one and is decided per call by
 * {@link intentFor} rather than here, because an edit is only a retarget
 * when it moves the base. Mapping every edit to `retarget` made a title
 * change ask Meteorite whether it could retarget, which it answers by
 * explaining that retargeting is a stack operation there: a true
 * sentence, and no reason at all to refuse a new title.
 */
const INTENT: Record<OfferParams["action"], AuthoringIntent["kind"]> = {
	propose: "propose",
	"propose-stack": "propose-stack",
	edit: "retarget",
	// Retargeting a stack is a retarget, whichever route carries it out,
	// so it meets the same queue gate as moving one change's base. That
	// is the point of mapping it here rather than exempting it: a stack
	// with an enqueued change in it ejects that change too.
	"retarget-stack": "retarget",
	ready: "set-draft",
	unready: "set-draft",
	close: "close",
	reopen: "reopen",
	merge: "merge",
	reviewers: "request-reviewers",
	rerun: "rerun-checks",
};

/**
 * What this call actually amounts to, which for an edit depends on what
 * it is editing.
 *
 * Only a base change is a retarget. Everything else an edit can touch,
 * meaning a title, a body, labels or assignees, is available wherever
 * proposing is, so asking about retargeting would refuse work that was
 * never in question.
 */
/**
 * What to say when a capability promised a method the provider does not have.
 *
 * Every write in this file announces itself in the past tense on the line
 * after the call, so an optional call that resolves to undefined because
 * the method is absent tells somebody their change moved when it did not.
 * Nothing logs it, nothing retries, and the backend is untouched while the
 * session's account of it is wrong: recovery needs a person to go and look.
 *
 * The capability gate above refuses first for every provider that ships
 * today, so this is what happens when one declares a capability without the
 * method behind it. That case is exactly the one a build-time check cannot
 * reach, since a provider arrives over the bus from a package that may
 * never have copied the check.
 */
function missingMethod(providerId: string, what: string): string {
	return `The ${providerId} provider declares it can ${what} but exposes no way to do it, so nothing happened. This is a bug in the provider rather than something you did.`;
}

function intentFor(params: OfferParams): AuthoringIntent["kind"] {
	if (params.action !== "edit") return INTENT[params.action];
	const movesBase =
		params.base !== undefined || (params.clear ?? []).includes("base");
	return movesBase ? "retarget" : "edit";
}

/** Register the `review_offer` tool. */
export function registerOfferTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review_offer",
		label: "Review Offer",
		description:
			"Put work up for review and move it along: propose a change from a branch, edit its title, body or base, move it between draft and ready, ask people to look at it, close or reopen it, and merge it. Reading a change is review_see. This is how a pull request is opened, whatever hosts it, including when the request says cut, raise, submit or put up rather than review: `gh pr create` reaches GitHub only, so on a repo hosted elsewhere it opens a change on a mirror nothing reads and every later `gh` call is blind to it.",
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
					Type.Literal("propose-stack"),
					Type.Literal("edit"),
					Type.Literal("ready"),
					Type.Literal("unready"),
					Type.Literal("close"),
					Type.Literal("reopen"),
					Type.Literal("merge"),
					Type.Literal("reviewers"),
					Type.Literal("rerun"),
					Type.Literal("retarget-stack"),
				],
				{
					description:
						"What to do. propose: put a branch up as a change. propose-stack: put up several at once, each based on the one before it. edit: change its title, body or base. ready: mark it ready for review; unready: put it back to a draft. reviewers: ask people to look. close and reopen. merge: land it. rerun: ask CI to run again, optionally naming one pipeline in 'which'. retarget-stack: after a local restack, point every change in the stack back at the branch it now sits on, natively where the backend holds the stack and change by change where it does not.",
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
			heads: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"For propose-stack: the branches, in dependency order with the root first. Each is proposed onto the one before it, and the first onto base. The order is yours because nothing here can work it out.",
				}),
			),
			bodies: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"For propose-stack: one body per branch, in the same order as heads. Held to the PR format, the same as a single propose. Omit to open the stack with empty bodies, and give as many as there are branches: a shorter list is refused rather than paired off against the branches it happens to reach.",
				}),
			),
			title: Type.Optional(
				Type.String({
					description:
						"For propose and edit: the title. On propose it defaults to the last commit's subject.",
				}),
			),
			body: Type.Optional(
				Type.String({
					description:
						"For propose and edit: the description. Held to the PR format and the prose standard, the same as the shell path is.",
				}),
			),
			draft: Type.Optional(
				Type.Boolean({
					description:
						"For propose: whether it opens as a draft. Required for propose, since the backends default opposite ways.",
				}),
			),
			comment: Type.Optional(
				Type.String({ description: "For close: why, said on the change." }),
			),
			which: Type.Optional(
				Type.String({
					description:
						"For rerun: one pipeline to run, named as the backend names it. Omit to rerun everything on the change's head commit, which costs whatever that costs.",
				}),
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
			labels: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"For propose and edit: labels to put on the change. On edit these are added to whatever is already there, so naming one does not remove the others. Use labelMode to replace instead, or clear to strip them all.",
				}),
			),
			labelMode: Type.Optional(
				Type.Union([Type.Literal("add"), Type.Literal("set")], {
					description:
						"For edit: whether labels are added to the change or replace what it has. Defaults to add, since replacing loses labels somebody else put there.",
				}),
			),
			unlabels: Type.Optional(
				Type.Array(Type.String(), {
					description: "For edit: labels to take off the change.",
				}),
			),
			assignees: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"For propose and edit: who to assign, named the way the backend names people. GitHub wants logins; some backends want email addresses. Added rather than replacing, like labels.",
				}),
			),
			unassignees: Type.Optional(
				Type.Array(Type.String(), {
					description: "For edit: who to unassign.",
				}),
			),
			clear: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"For edit: fields to empty, e.g. body, labels, assignees.",
				}),
			),
		}),

		renderCall(args, theme, context) {
			const params = args as { action?: string; change?: string };
			return renderInvocation(
				theme,
				"review_offer",
				params.action,
				params.change,
				context?.lastComponent,
			);
		},

		renderResult(result, options, theme, context) {
			return renderAnswer(result, theme, options, context?.lastComponent);
		},

		async execute(_id, params, _signal, _onUpdate, ctx): Promise<Answer> {
			// Held outside the try so a failure can say which provider was
			// asked. Most of what fails here fails against a backend, and the
			// backend's own message is about its own request.
			let bound: BoundTarget | undefined;
			try {
				// Before the bind, because none of it needs a provider and a
				// refusal should leave nothing behind. Binding remembers what it
				// resolved for the rest of the session, so a call that was never
				// going to be sent has no business recording a decision, and a
				// convention refusal now costs no backend round trip either.
				if (params.action === "propose" || params.action === "edit") {
					const complaint = proposalComplaint(params.title, params.body);
					if (complaint) return refuse(complaint);
				}

				bound = await boundFor(pi, params, process.cwd());
				const authoring = bound.provider.authoring;

				// Proposing takes its repo from the checkout whenever the call
				// names a base and a head, since `boundFor` prefers that over the
				// attachment, and from the attachment only when it names neither.
				// The checkout winning is right: the branch being proposed exists
				// only in the repo it was committed in.
				//
				// This is why the attachment path needs the refusal below.
				// Reading a change on one backend and then proposing from a
				// checkout of another would offer the local branch to the attached
				// repo, and nothing said so: the gate named a head and a base and
				// never a repo, so the only clue was a base branch that looked
				// ordinary.
				//
				// Note what the checkout resolves to now. `fromLocal` mints a
				// `local:` key for the target and hands the probe to every
				// provider, so a provider that claims the checkout answers with
				// its own hosted key and that is what gets bound. It used to be
				// read back as the `local:` key on every call after the first,
				// which is what sent a hosted repo to plain git and lost the
				// authoring facet with it.
				//
				// Refused rather than quietly corrected, since the right answer
				// is not available here to substitute.
				if (params.action === "propose" || params.action === "propose-stack") {
					const elsewhere = await proposingElsewhere(
						pi,
						params.repo ?? process.cwd(),
						bound,
					);
					if (elsewhere) return refuse(elsewhere);
				}

				// Where the change stands with a merge queue, read from the
				// provider rather than taken on the caller's word. This is the
				// line that was missing: the refusal below has always been able
				// to fire on a queued change, and nothing ever told it one was.
				const intent = intentFor(params);

				const queue =
					ASKS_THE_QUEUE.has(params.action) &&
					bound.capabilities.authoring?.refusesWhileEnqueued &&
					bound.target.kind === "proposal"
						? (await bound.provider.proposals?.fetch(bound.target.change))
								?.queue
						: undefined;

				// Asked before anything is sent, and asked of this repo
				// rather than of the provider in general, since a provider
				// can be able to do something everywhere but here.
				const allowed = offerable(
					{
						kind: intent,
						...(params.action === "propose" && params.reviewers?.length
							? { withReviewers: true }
							: {}),
						...(queue ? { queue } : {}),
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

				// Permitted, but with something the approver needs to know: a
				// backend that has a merge queue and could not say where this
				// change sits in it. Carried to the gate rather than logged,
				// because the gate is the only place a person is looking.
				const caution = allowed.caution;
				if (!authoring) {
					return refuse(
						`The ${bound.provider.id} provider says it can author changes but exposes no way to, which is a bug in that provider rather than in what you asked.`,
					);
				}

				// The title and body were checked before the bind: whatever text
				// is about to become a proposal is held to the same conventions
				// the guardian enforces on `gh pr create`, or authoring through a
				// tool is a way around every rule the shell path cannot be talked
				// past.
				//
				// Named people are held to the form this backend names people
				// in, here rather than in each action, since assignees and
				// reviewers reach three of them. Before anything is sent: a
				// backend that refuses an assignee refuses it on the request
				// that creates the change, so finding out later means finding
				// out with the change already up.
				const misnamed = peopleComplaint(bound, params);
				if (misnamed) return refuse(misnamed);
				// A stack's titles come from commit subjects rather than from
				// the caller, and those are already held to the standard by the
				// commit guardian, so there is nothing here to check ahead of
				// the gate that shows them.

				if (params.action === "propose") {
					return propose(pi, ctx, bound, authoring, params);
				}

				if (params.action === "propose-stack") {
					return proposeStack(pi, ctx, bound, authoring, params);
				}

				const change = hostedChange(bound);
				if (!change) {
					return refuse(
						"Nothing hosts this target, so there is no change to act on. Propose it first.",
					);
				}

				switch (params.action) {
					case "edit":
						return edit(ctx, change, authoring, params, caution);
					case "ready":
					case "unready": {
						const wanted = params.action === "unready";
						const decision = await confirmWrite(
							ctx,
							`Move ${change.label} to ${wanted ? "Draft" : "Ready"}`,
							cautioned(`${GLYPH.target} ${change.label}`, caution),
						);
						if (!decision.approved)
							return declined(decision, "Left as it was.");
						if (authoring.setDraft === undefined) {
							return refuse(
								missingMethod(
									bound.provider.id,
									"move a change between draft and ready",
								),
							);
						}
						await authoring.setDraft(change, wanted);
						return say(
							`${GLYPH.lands} ${change.label} is now ${wanted ? "a draft" : "ready for review"}.`,
						);
					}
					case "close": {
						const decision = await confirmWrite(
							ctx,
							`Close ${change.label}`,
							closePanel({
								label: change.label,
								...(params.comment ? { comment: params.comment } : {}),
							}),
						);
						if (!decision.approved) return declined(decision, "Left open.");
						await authoring.close(
							change,
							...(params.comment === undefined ? [] : [params.comment]),
						);
						return say(`${GLYPH.lands} ${change.label} closed.`);
					}
					case "reopen": {
						const decision = await confirmWrite(
							ctx,
							`Reopen ${change.label}`,
							`${GLYPH.target} ${change.label}`,
						);
						if (!decision.approved) return declined(decision, "Left closed.");
						if (authoring.reopen === undefined) {
							return refuse(
								missingMethod(bound.provider.id, "reopen a closed change"),
							);
						}
						await authoring.reopen(change);
						return say(`${GLYPH.lands} ${change.label} reopened.`);
					}
					case "rerun": {
						const decision = await confirmWrite(
							ctx,
							`Run CI Again on ${change.label}`,
							[
								`${GLYPH.target} ${change.label}`,
								params.which
									? `\nJust ${params.which}.`
									: "\nEverything on its head commit, which on a large repo is not free.",
							].join("\n"),
						);
						if (!decision.approved) return declined(decision, "Left alone.");
						if (authoring.rerun === undefined) {
							return refuse(
								missingMethod(bound.provider.id, "ask CI to run again"),
							);
						}
						const outcome = await authoring.rerun(
							change,
							...(params.which === undefined ? [] : [params.which]),
						);
						// Declined is reported as plainly as started. A backend that
						// understood and said no is not a failure, and narrating it
						// as success is how somebody ends up waiting on a build that
						// was never queued.
						return outcome.kind === "started"
							? say(
									`${GLYPH.queued} CI asked to run again on ${change.label}${outcome.which ? `, ${outcome.which} only` : ""}. Results arrive later; read them with review_see checks.`,
								)
							: refuse(
									`${bound.provider.id} declined to rerun CI on ${change.label}: ${outcome.reason}.`,
								);
					}
					case "retarget-stack":
						return retargetStack(ctx, bound, change, authoring);
					case "merge":
						return merge(ctx, bound, change, authoring, params);
					case "reviewers":
						return reviewers(ctx, change, authoring, params);
				}
			} catch (error) {
				return refuseFailure(error, bound);
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
/**
 * What a branch is stacked on, or nothing if it is not stacked.
 *
 * Every failure is nothing rather than a throw. A stack is an
 * optional convenience here: not having one means the base falls back
 * to the trunk, which is what happened before any of this existed.
 */
async function parentOf(
	pi: ExtensionAPI,
	cwd: string,
	branch: string,
): Promise<string | undefined> {
	try {
		const exec: Exec = (command, args) => pi.exec(command, [...args]);
		const stacks = createGitStacks({
			exec,
			rebaser: createGitRebaser({ exec }),
		});
		const tracked = await stacks.read(cwd);
		return tracked.find((step) => step.name === branch)?.parent;
	} catch {
		// No stack tracked here, or not a repo at all. The base falls
		// back to the trunk, which is the behaviour that predates stacks.
		return undefined;
	}
}

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

	// What this branch sits on, when a stack says it sits on anything.
	// Asked here rather than in the filler because it is the checkout
	// that knows, and the filler is pure so it can be tested without
	// one.
	const parent =
		branch === undefined || branch === "HEAD"
			? undefined
			: await parentOf(pi, cwd, branch);

	return {
		// A detached head reports the literal word HEAD, which is not a
		// branch anybody can push.
		...(branch !== undefined && branch !== "HEAD" ? { branch } : {}),
		...(originHead === undefined
			? {}
			: { trunk: originHead.replace(/^origin\//, "") }),
		...(parent === undefined ? {} : { parent }),
		...(subject === undefined ? {} : { subject }),
		...(body === undefined ? {} : { bodyFromCommits: body }),
		...(status === undefined ? {} : { dirty: true }),
	};
}

/**
 * A refusal when the repo being proposed to is not the one you are in.
 *
 * The repo comes from the attached change, and the branch comes from the
 * checkout, so the two can disagree and the result is a proposal offering a
 * branch to a repo that does not have it. The backend's own refusal for that
 * is about a missing ref and says nothing about why.
 *
 * The comparison is deliberately coarse: a hosted repo's key ends in the
 * owner and name the backend knows it by, and a remote URL for that repo
 * contains the same pair however it is spelled, ssh or https. Anything more
 * exact would need a URL parser per backend, and this only has to catch a
 * disagreement, not adjudicate a match.
 *
 * Says nothing when there is no remote to compare against, since a checkout
 * with no origin is a legitimate place to propose from: the work may be going
 * up to a repo this clone has never spoken to.
 */
export async function proposingElsewhere(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	bound: Pick<BoundTarget, "repo">,
): Promise<string | undefined> {
	const apart = await checkoutElsewhere(pi, cwd, bound);
	if (!apart) return undefined;

	return `This checkout is ${apart.checkout}, and the change in play is on ${apart.repo}, so a branch here cannot be proposed there. Detach that change, or name the repo to propose from with repo.`;
}

/**
 * The subject of a branch's tip commit, for naming its change.
 *
 * One call per branch rather than a walk of the whole stack, because the
 * branches are named by the caller and need not be contiguous in any order
 * git knows about.
 */
async function tipSubject(
	pi: ExtensionAPI,
	cwd: string,
	branch: string,
): Promise<string | undefined> {
	try {
		const result = await pi.exec("git", [
			"-C",
			cwd,
			"log",
			"-1",
			"--format=%s",
			branch,
		]);
		const out = result.stdout.trim();
		return result.code === 0 && out !== "" ? out : undefined;
	} catch {
		// No such branch, or no git. The caller refuses by name rather than
		// proposing a change called nothing.
		return undefined;
	}
}

/**
 * Put a whole stack up, each change based on the one before it.
 *
 * The order is the caller's, roots first, because nothing here can work it
 * out. A stack lives in a tool that tracks parentage, and the working layer
 * has no stacks facet yet, so asking the caller is honest where inferring
 * from merge-base would be a guess dressed as a fact.
 *
 * This exists because `proposeStack` had been declared, implemented and
 * advertised by `review capabilities` as "propose a stack" while no verb
 * could reach it. A capability a caller is told about and cannot use is the
 * same lie as one that does not work, told from the other end.
 */
async function proposeStack(
	pi: ExtensionAPI,
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	bound: BoundTarget,
	authoring: NonNullable<BoundTarget["provider"]["authoring"]>,
	params: OfferParams,
): Promise<Answer> {
	if (params.draft === undefined) {
		return refuse(
			"Say whether these open as drafts. It is not defaulted, because the backends disagree about what silence means.",
		);
	}
	const heads = params.heads ?? [];
	if (heads.length < 2) {
		return refuse(
			"A stack needs at least two branches, named roots first. For one branch, propose it.",
		);
	}
	if (authoring.proposeStack === undefined) {
		return refuse(missingMethod(bound.provider.id, "propose a stack"));
	}

	// Positional, aligned to `heads`, because `heads` already carries the
	// dependency order. A shorter list is refused rather than paired off
	// against the branches it reaches: quietly leaving the last change empty
	// puts a body somebody wrote on a change they did not mean.
	const bodies = params.bodies;
	if (bodies !== undefined && bodies.length !== heads.length) {
		return refuse(
			`This names ${count(heads.length, "branch", "branches")} and ${count(bodies.length, "body", "bodies")}. Give one body per branch, in the same order, or none at all.`,
		);
	}

	// Every body, not just the first, and before anything is sent. The stack
	// path is not a way around the conventions the single path enforces.
	for (const [at, body] of (bodies ?? []).entries()) {
		const complaint = proposalComplaint(undefined, body);
		if (complaint) {
			return refuse(`The body for ${heads[at]} is not usable.\n\n${complaint}`);
		}
	}

	const repeated = heads.filter((one, at) => heads.indexOf(one) !== at);
	if (repeated.length > 0) {
		// A branch twice in a stack would be proposed onto itself, and the
		// backend's refusal for that is not worth passing on.
		return refuse(
			`${repeated[0]} is named twice. A stack is an order, so each branch appears once.`,
		);
	}

	const cwd = params.repo ?? process.cwd();
	const facts = await checkoutFacts(pi, cwd);
	const base = params.base ?? facts.trunk;
	if (base === undefined) {
		return refuse(
			"There is no trunk here to stack onto, so name the base the first change merges into.",
		);
	}

	const subjects = await Promise.all(
		heads.map((head) => tipSubject(pi, cwd, head)),
	);
	const missing = heads.filter((_, at) => subjects[at] === undefined);
	if (missing.length > 0) {
		return refuse(
			`This checkout has no branch called ${missing.join(" or ")}, so there is nothing to propose for it.`,
		);
	}

	// Each onto the one before it, which is what makes this a stack rather
	// than a handful of changes proposed together.
	const drafts = heads.map((head, at) => ({
		repo: bound.repo,
		base: at === 0 ? base : heads[at - 1],
		head,
		title: subjects[at] ?? head,
		body: bodies?.[at] ?? "",
		draft: params.draft === true,
	}));

	const decision = await confirmWrite(
		ctx,
		`Propose ${heads.length} Changes as a Stack`,
		[
			`${GLYPH.target} on ${bound.repo.key}`,
			...drafts.map(
				(one, at) =>
					`   ${at + 1}. ${one.title}\n      ${one.head} \u2192 ${one.base}`,
			),
			"",
			// Said plainly, because a stack is the case where a partial
			// outcome is most likely and hardest to read afterwards.
			"Each is based on the one above it, so an earlier one failing leaves the rest without a base.",
		].join("\n"),
	);
	if (!decision.approved) return declined(decision, "Not proposed.");

	const made = await authoring.proposeStack(drafts);

	// The notes go on afterwards because a note names the changes either
	// side, and no number exists until every change does. This is the only
	// place they are all known at once: left to the caller it is one edit
	// per change, each its own gated call, each easy to forget half way.
	const noted = await annotateStack(authoring, made, drafts);

	return say(
		[
			`${GLYPH.lands} ${made.length} of ${drafts.length} proposed`,
			...made.map((one) => `   ${proposalLine(one)}`),
			...(noted ? [`   ${GLYPH.refused} ${noted}`] : []),
		].join("\n"),
		{ ok: true, proposed: made.length, asked: drafts.length },
	);
}

/**
 * Write each change's stack note, and say if that failed.
 *
 * Undefined when every note landed. A failure here must not lose the
 * changes: the stack is up by then, and reporting a bare failure
 * describes a world where it is not, which invites proposing it again.
 * So this answers with what went wrong rather than throwing.
 *
 * Skipped for a body nobody wrote. Editing an empty body to hold nothing
 * but a note would put the navigation where the description should be.
 */
async function annotateStack(
	authoring: NonNullable<BoundTarget["provider"]["authoring"]>,
	made: Proposal[],
	drafts: { body: string }[],
): Promise<string | undefined> {
	if (made.length < 2) return undefined;

	const failures: string[] = [];
	for (const [at, one] of made.entries()) {
		const body = drafts[at]?.body;
		if (!body) continue;
		try {
			await authoring.edit(one.ref, {
				body: {
					action: "set",
					value: withStackNote(body, made, at),
				},
			});
		} catch (error) {
			failures.push(`${one.ref.label}: ${messageOf(error)}`);
		}
	}
	if (failures.length === 0) return undefined;
	return `the stack is up, and its notes are not: ${failures.join("; ")}`;
}

/**
 * A body with its stack note above it.
 *
 * The shape is the github-pr-format skill's: the change below, this one
 * in bold, the change above. The bottom of a stack has nothing below it
 * and the top nothing above, so each keeps only the segments pointing
 * somewhere rather than printing a dangling arrow.
 */
function withStackNote(body: string, made: Proposal[], at: number): string {
	const below = at > 0 ? made[at - 1]?.ref.label : undefined;
	const above = at < made.length - 1 ? made[at + 1]?.ref.label : undefined;
	const segments = [
		...(below ? [`\u{1F448} ${below}`] : []),
		`\u{1F447} **${made[at]?.ref.label}**`,
		...(above ? [`\u{1F449} ${above}`] : []),
	];
	return ["> [!NOTE]", `> ${segments.join(" \u00b7 ")}`, "", body].join("\n");
}

/** Put a branch up as a change. */
/**
 * One field an edit changes, as the gate needs to describe it.
 *
 * The union of what a proposal edit can carry, rather than a shape of
 * this file's own: a gate that models fewer actions than the contract
 * allows draws some edits as `undefined`.
 */
export type GateEdit = FieldEdit<string> | SetEdit<string>;

/**
 * Draw the close gate.
 *
 * The comment is the payload because it is authored prose that lands on
 * the change, and it is the only part a reader cannot reconstruct.
 */
export function closePanel(gate: {
	label: string;
	comment?: string;
}): GatePanel {
	return {
		destination: gate.label,
		...(gate.comment ? { payload: { body: gate.comment } } : {}),
		// Said rather than left absent: nothing on a closed change reads as
		// abandonment to whoever finds it later.
		...(gate.comment
			? {}
			: {
					consequence: [
						"No reason will be left on it, which reads as abandonment.",
					],
				}),
	};
}

/**
 * Draw the edit gate.
 *
 * A new body is the payload, so it renders and is never clipped. It used
 * to be sliced at 200 characters, which is mid-sentence for the shortest
 * body this package will write, and the slice was invisible: what the
 * gate showed and what would land stopped being the same text.
 *
 * Every other field stays a one-line summary, since a label or a base is
 * fully described by naming it.
 */
export function editPanel(gate: {
	label: string;
	edits: Record<string, GateEdit | undefined>;
	caution?: string;
}): GatePanel {
	const body = gate.edits.body;
	const newBody =
		body?.action === "set" && typeof body.value === "string"
			? body.value
			: undefined;
	return {
		destination: gate.label,
		...(newBody === undefined ? {} : { payload: { body: newBody } }),
		consequence: [
			...(gate.caution ? [`${GLYPH.refused} ${gate.caution}`] : []),
			...Object.entries(gate.edits)
				// The body is above, drawn whole. Naming it here as well would
				// say the same edit twice.
				.filter(([field]) => !(field === "body" && newBody !== undefined))
				.map(([field, edit]) => `${field}: ${describeEdit(edit)}`),
		],
	};
}

/**
 * One edit in a phrase.
 *
 * A set edit says which way it is going, since "labels: risky" reads as a
 * replacement and usually is not one.
 */
function describeEdit(edit: GateEdit | undefined): string {
	if (edit === undefined) return "unchanged";
	if (edit.action === "clear") return "cleared";
	const value = Array.isArray(edit.value)
		? edit.value.join(", ")
		: String(edit.value);
	return edit.action === "set" ? value : `${edit.action} ${value}`;
}

/** What the propose gate needs to draw itself. */
export interface ProposalGate {
	head: string;
	base: string;
	/** The repo key, named because the checkout cannot tell you it. */
	repo: string;
	title: string;
	body: string;
	draft: boolean;
	reviewers?: string[];
	/** Fields taken from the checkout rather than given. */
	guessed?: string[];
	warnings?: string[];
	/** Something permitted that the approver still needs to know. */
	caution?: string;
}

/**
 * Draw the propose gate.
 *
 * A panel rather than a joined string, so the body reaches
 * `renderMarkdown` and the inset the way every other gate's does. A PR
 * body is the most markdown-heavy text this package produces, and raw
 * wrapping showed its section headings as literal `###`.
 *
 * Pure, which is what makes it testable: the terminal stays in the thin
 * call that shows the result.
 */
export function proposePanel(gate: ProposalGate): GatePanel {
	return {
		// The repo is named because it is the one thing here not taken from
		// the checkout, so it is the one thing a reader cannot verify by
		// knowing where they are standing.
		destination: `${gate.head} → ${gate.base} on ${gate.repo}`,
		where: `${gate.title}${gate.draft ? " · draft" : ""}`,
		...(gate.body ? { payload: { body: gate.body } } : {}),
		consequence: [
			...(gate.reviewers?.length
				? [`Asking: ${gate.reviewers.join(", ")}`]
				: []),
			// Named rather than merely used, so a wrong guess is caught here by
			// the one person who can tell.
			...(gate.guessed?.length
				? [`Taken from the checkout: ${gate.guessed.join(", ")}.`]
				: []),
			...(gate.caution ? [`${GLYPH.refused} ${gate.caution}`] : []),
			...(gate.warnings ?? []).map((warning) => `${GLYPH.refused} ${warning}`),
		],
	};
}

/**
 * Whether the people named are named the way this backend names people.
 *
 * Asked before anything is sent. A backend that refuses an assignee does
 * it on the request that creates the change, so finding out afterwards
 * means finding out with the change already up.
 */
function peopleComplaint(
	bound: BoundTarget,
	params: OfferParams,
): string | undefined {
	const form = bound.capabilities.authoring?.identifies ?? "unknown";
	const named = [...(params.assignees ?? []), ...(params.reviewers ?? [])];
	const complaint = misnamedPeople(named, form);
	return complaint === undefined
		? undefined
		: `${complaint} Name them the way ${bound.provider.id} does.`;
}

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

	const decision = await confirmWrite(
		ctx,
		`Propose ${head} onto ${base}`,
		proposePanel({
			head,
			base,
			repo: bound.repo.key,
			title,
			body,
			draft: params.draft,
			...(params.reviewers?.length ? { reviewers: params.reviewers } : {}),
			...(guessed.length > 0 ? { guessed } : {}),
			...(warnings.length > 0 ? { warnings } : {}),
		}),
	);
	if (!decision.approved) return declined(decision, "Not proposed.");

	// Where the reviewers go depends on when the backend can take them. One
	// that takes them only at creation has to be told now, because after
	// this call there is no moment left; one that takes them any time is
	// asked afterwards, against the change that now exists.
	const atCreation =
		bound.capabilities.authoring?.reviewersAt === "creation" &&
		(params.reviewers?.length ?? 0) > 0;

	const made: Proposal = await authoring.propose({
		repo: bound.repo,
		base,
		head,
		title,
		body,
		draft: params.draft,
		...(params.labels?.length ? { labels: params.labels } : {}),
		...(params.assignees?.length ? { assignees: params.assignees } : {}),
		...(atCreation && params.reviewers ? { reviewers: params.reviewers } : {}),
	});

	// Otherwise after the change exists, since there is nothing to ask
	// anyone to look at before that. A failure here leaves a real change
	// behind, so it is reported rather than thrown: losing the change
	// because the ask failed would be the worse trade.
	let asking = atCreation
		? `\n   asked ${(params.reviewers ?? []).join(", ")}`
		: "";
	if (params.reviewers?.length && !atCreation) {
		try {
			// Not an optional call. Reporting "asked alice, bob" because the
			// method was absent is the one degradation nobody can detect: it
			// is said in the past tense about something that never happened,
			// and the reviewers are simply never asked.
			if (authoring.requestReviewers === undefined) {
				throw new Error(missingMethod(bound.provider.id, "request reviewers"));
			}
			await authoring.requestReviewers(made.ref, params.reviewers);
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

/**
 * How a set of labels or assignees is changing, or nothing.
 *
 * Adding is the default and replacing has to be asked for, because a
 * caller naming one label almost always means "also this" rather than
 * "only this", and guessing wrong silently removes work somebody else
 * did. Clearing is separate again, through `clear`, so emptying a set is
 * always deliberate.
 *
 * Removal wins when both are named for the same field, since asking to
 * add and remove the same label at once is a contradiction and taking it
 * off is the safer reading of it.
 */
function setEditFor(
	add: string[] | undefined,
	remove: string[] | undefined,
	cleared: boolean,
	mode: "add" | "set" | undefined,
): SetEdit<string> | undefined {
	if (cleared) return { action: "clear" };
	if (remove?.length) return { action: "remove", value: remove };
	if (!add?.length) return undefined;
	return { action: mode === "set" ? "set" : "add", value: add };
}

/**
 * A gate's detail, with a warning above it when there is one.
 *
 * The caution goes first and is marked, because a person skimming an
 * approval reads the top line and the question. Putting it under the
 * detail is the same as not saying it.
 */
function cautioned(detail: string, caution: string | undefined): string {
	return caution ? `${GLYPH.refused} ${caution}\n\n${detail}` : detail;
}

/** Change a title, a body, a base, labels or assignees. */
async function edit(
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	change: NonNullable<ReturnType<typeof hostedChange>>,
	authoring: NonNullable<BoundTarget["provider"]["authoring"]>,
	params: OfferParams,
	caution?: string,
): Promise<Answer> {
	const clearing = new Set(params.clear ?? []);
	const set = <T>(
		value: T | undefined,
		field: string,
	): FieldEdit<T> | undefined => {
		if (clearing.has(field)) return { action: "clear" };
		return value === undefined ? undefined : { action: "set", value };
	};

	const labels = setEditFor(
		params.labels,
		params.unlabels,
		clearing.has("labels"),
		params.labelMode,
	);
	const assignees = setEditFor(
		params.assignees,
		params.unassignees,
		clearing.has("assignees"),
		params.labelMode,
	);

	const edits = {
		...(set(params.title, "title")
			? { title: set(params.title, "title") }
			: {}),
		...(set(params.body, "body") ? { body: set(params.body, "body") } : {}),
		...(set(params.base, "base") ? { base: set(params.base, "base") } : {}),
		...(labels ? { labels } : {}),
		...(assignees ? { assignees } : {}),
	};
	if (Object.keys(edits).length === 0) {
		return refuse(
			"Editing needs something to change: a title, a body, a base, labels, assignees, or a field to clear.",
		);
	}

	const decision = await confirmWrite(
		ctx,
		`Edit ${change.label}`,
		editPanel({
			label: change.label,
			edits,
			...(caution ? { caution } : {}),
		}),
	);
	if (!decision.approved) return declined(decision, "Left as it was.");

	const after = await authoring.edit(change, edits);
	// Named in the past tense, because the proposal line alone does not show
	// most of what an edit can change: labels and assignees are not on it, so
	// an edit that set a label answered with exactly what an edit that did
	// nothing would answer. It was landing correctly and reporting nothing,
	// which is only one step better than the reverse and just as hard to
	// notice, since the gate said what was coming and nothing said what came.
	const changed = Object.entries(edits).map(([field, edit]) =>
		edit?.action === "clear" ? `${field} cleared` : field,
	);
	return say(
		`${GLYPH.lands} ${proposalLine(after)}\n   ${changed.join(", ")} updated`,
	);
}

/**
 * Why this merge should not happen, when the head is not what was expected.
 *
 * Says both heads, because the useful fact is which one the change is at and
 * that is what the backend's own refusal leaves out. A prefix is accepted, so
 * the short form a commit prints is a valid expectation rather than a
 * guaranteed mismatch, but it has to be a prefix of the real head and not
 * merely look like one.
 *
 * Undefined when there is nothing to check: no expectation given, or a
 * provider that does not report where the head is, in which case the guard
 * still travels to the backend and this adds nothing.
 */
async function headMismatch(
	bound: BoundTarget,
	label: string,
	expected: string | undefined,
): Promise<string | undefined> {
	if (!expected) return undefined;
	const at = (await bound.proposal())?.headCommit;
	if (!at || at === expected || at.startsWith(expected)) return undefined;
	return [
		`${label} is at ${at}, not ${expected}, so it was not merged.`,
		"That is the head guard doing its job, and it does not mean somebody pushed:",
		"an expectation typed from memory or completed from a short prefix fails the",
		"same way. Read the head, then merge with what it says.",
	].join("\n");
}

/** Land the change. */
async function merge(
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	bound: BoundTarget,
	change: NonNullable<ReturnType<typeof hostedChange>>,
	authoring: NonNullable<BoundTarget["provider"]["authoring"]>,
	params: OfferParams,
): Promise<Answer> {
	// Checked here, before the gate, rather than left to the backend. Two
	// reasons. The backend that has this guard answers "Head branch was
	// modified", which names a cause that is false whenever the expectation
	// was stale or mistyped rather than the branch having moved, and it sends
	// the reader hunting a push nobody made. And not every backend enforces
	// it at all, so a guard the caller asked for would otherwise be silently
	// optional. The head this change is at is already in hand.
	const mismatch = await headMismatch(bound, change.label, params.expectedHead);
	if (mismatch) return refuse(mismatch);

	const decision = await confirmWrite(
		ctx,
		`Merge ${change.label}`,
		[
			`${GLYPH.target} ${change.label}`,
			params.method ? `   ${params.method}` : "   the repo's own merge policy",
			params.expectedHead
				? `   only if the head is still ${params.expectedHead}`
				: `   ${GLYPH.refused} unguarded: this merges whatever the head is now, including work pushed since you last looked`,
		].join("\n"),
	);
	if (!decision.approved) return declined(decision, "Not merged.");

	const outcome = await authoring.merge(change, {
		...(params.method === undefined ? {} : { method: params.method }),
		...(params.expectedHead === undefined
			? {}
			: { expectedHead: params.expectedHead }),
	});

	// This used to say `merged` whatever came back, which is true on a backend
	// that merges when asked and a lie on one fronted by a queue, where the
	// change has been accepted for a batch that may still fail CI. The reader
	// of that sentence goes on to prune the branch and call the work done.
	if (outcome.kind === "enqueued") {
		return say(
			`${GLYPH.queued} ${change.label} enqueued${outcome.detail ? `: ${outcome.detail}` : ""}. It lands when the queue reaches it, and not at all if its checks fail, so do not prune the branch on the strength of this.`,
			{ ok: true, merged: false, enqueued: true },
		);
	}
	// Landing is the moment a change stops being in play, and nothing
	// used to say so, so the attachment outlived the change it named
	// and every later call still preferred it. A session that had
	// shipped eight changes carried eight of them, and each one
	// hijacked the calls whose subject is a repo rather than a change:
	// naming a checkout was answered with "the change in play is on
	// ...", once per pop, eight times over.
	//
	// Only here, and not for a change the queue has merely accepted.
	// That one lands when the queue reaches it and not at all if its
	// checks fail, which is exactly the state in which it is still
	// yours to watch.
	const letGo = await attachments().detach(change.label);
	return say(
		`${GLYPH.lands} ${change.label} merged${outcome.commit ? ` at ${outcome.commit.slice(0, 12)}` : ""}.${letGo ? " Detached, since it is no longer what you are working on." : ""}`,
		{
			ok: true,
			merged: true,
			detached: letGo,
			...(outcome.commit === undefined ? {} : { commit: outcome.commit }),
		},
	);
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

	const decision = await confirmWrite(
		ctx,
		`Ask ${asking.join(", ")} to Review ${change.label}`,
		`${GLYPH.target} ${change.label}`,
	);
	if (!decision.approved) return declined(decision, "Nobody was asked.");

	// Said in the past tense, so it has to be true. An optional call here
	// reported that people had been asked whenever the method was missing,
	// which is a degradation with no symptom: the change simply sits there
	// with nobody looking at it. The capability gate refuses first for every
	// provider that ships today, and this is what happens when one declares
	// the capability without the method behind it.
	if (authoring.requestReviewers === undefined) {
		return refuse(
			`${missingMethod(change.provider, "request reviewers")} Ask them directly instead.`,
		);
	}

	await authoring.requestReviewers(change, asking);
	return say(`${GLYPH.lands} asked ${asking.join(", ")}.`);
}

/**
 * Point a stack's changes back at what they now sit on.
 *
 * A local restack moves branches and leaves the changes claiming to
 * merge into wherever they targeted when they went up. On a stack
 * whose bottom has landed, that is a change aimed at a branch nobody
 * is merging any more.
 */
async function retargetStack(
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	bound: BoundTarget,
	change: NonNullable<ReturnType<typeof hostedChange>>,
	authoring: NonNullable<BoundTarget["provider"]["authoring"]>,
): Promise<Answer> {
	if (bound.provider.stacking === undefined) {
		return refuse(
			`${bound.provider.id} does not read stacks, so there is nothing here to retarget. Move each change with review_offer edit base:...`,
		);
	}

	const route = retargetRoute(bound.provider.stacking, authoring);
	if ("refusal" in route) return refuse(route.refusal);

	const stack = await bound.provider.stacking.stack(change);
	const plan = retargetPlan(stack);
	if (plan.moves.length === 0) {
		// A no-op reported as a no-op. Saying "retargeted" about nothing
		// is how somebody concludes the stack was wrong and goes looking.
		return say(
			[
				`${GLYPH.lands} Every change in ${change.label}'s stack already targets what it sits on.`,
				...plan.skipped.map((one) => `   ${one.ref}: ${one.why}`),
			].join("\n"),
			{ ok: true, moved: 0 },
		);
	}

	const decision = await confirmWrite(
		ctx,
		`Retarget ${count(plan.moves.length, "Change", "Changes")} in ${change.label}'s Stack`,
		[
			...plan.moves.map(
				(move) => `${GLYPH.target} ${move.ref}: ${move.from} → ${move.to}`,
			),
			"",
			// Which route runs is shown, because the two fail differently
			// and this is the moment to know which one is about to.
			route.kind === "native"
				? `Moved as one: ${route.why}.`
				: `Moved one at a time: ${route.why}, so a failure part way leaves some moved and some not.`,
		].join("\n"),
	);
	if (!decision.approved)
		return declined(decision, "Left pointing where they were.");

	if (route.kind === "native") {
		// Non-null because retargetRoute only says native when it is there.
		await bound.provider.stacking.restack?.(change);
		return say(
			`${GLYPH.lands} Retargeted ${count(plan.moves.length, "change", "changes")} in ${change.label}'s stack, as one operation.`,
			{ ok: true, moved: plan.moves.length },
		);
	}

	// One at a time, reporting how far it got. A walk that stops half
	// way has genuinely moved some of them, and a bare failure would
	// leave somebody unable to tell that from having moved none.
	const moved: string[] = [];
	for (const move of plan.moves) {
		try {
			await authoring.edit(
				{ ...change, id: move.ref, label: move.ref },
				{ base: { action: "set", value: move.to } },
			);
			moved.push(`${move.ref} → ${move.to}`);
		} catch (error) {
			return refuse(
				[
					`Stopped at ${move.ref}: ${error instanceof Error ? error.message : String(error)}`,
					...(moved.length === 0
						? ["Nothing was moved."]
						: [
								`Already moved, and left that way: ${moved.join(", ")}.`,
								"Run this again once the cause is dealt with; what is already right is skipped.",
							]),
				].join("\n"),
			);
		}
	}

	return say(
		`${GLYPH.lands} Retargeted ${count(moved.length, "change", "changes")}: ${moved.join(", ")}.`,
		{ ok: true, moved: moved.length },
	);
}
