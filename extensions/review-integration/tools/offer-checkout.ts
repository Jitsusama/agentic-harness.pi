/**
 * What the checkout a `review_offer` call works in can tell it: the
 * branch, the trunk and what a stack sits it on, the ends a proposal
 * implies, its size, a tip's subject, and whether the checkout belongs
 * to the repo being proposed to at all.
 *
 * Apart from the actions because these change with how git and a stack
 * are read, and every read is allowed to fail into a fact rather than
 * an error.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Exec } from "../../../lib/core/exec/index.ts";
import type {
	BoundTarget,
	CheckoutFacts,
} from "../../../lib/core/review/index.ts";
import type { ChangeSize } from "../../../lib/core/sections/shape.ts";
import { createGitRebaser } from "../../../lib/core/work/rebase.ts";
import { createGitStacks } from "../../../lib/core/work/stacks.ts";
import { REVIEW_COMMANDS } from "../commands.ts";
import { attachments } from "../engine.ts";
import { checkoutSize } from "./change-size.ts";
import type { OfferParams } from "./offer-request.ts";
import { checkoutElsewhere } from "./shared.ts";

/**
 * What a branch is stacked on, or nothing if it is not stacked.
 *
 * Every failure is nothing rather than a throw. A stack is an
 * optional convenience here: not having one means the base falls back
 * to the trunk, which is what happened before any of this existed.
 */
async function parentOf(
	host: Pick<ExtensionAPI, "exec">,
	cwd: string,
	branch: string,
): Promise<string | undefined> {
	try {
		const exec: Exec = (command, args) => host.exec(command, [...args]);
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

/**
 * What the checkout can tell us, for filling a proposal in.
 *
 * Every read is allowed to fail. A detached head has no branch, a repo
 * with no origin has no trunk, and a fresh repo has no commit; each of
 * those is a fact rather than an error, and `fillProposal` decides
 * which ones it can live without.
 */
export async function checkoutFacts(
	host: Pick<ExtensionAPI, "exec">,
	cwd: string,
): Promise<CheckoutFacts> {
	const git = async (...args: string[]): Promise<string | undefined> => {
		try {
			const result = await host.exec("git", ["-C", cwd, ...args]);
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
			: await parentOf(host, cwd, branch);

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
 * A propose's target, with the head and base the checkout implies filled in.
 *
 * The head and base are documented as defaulting to the branch checked out
 * and the branch it sits on, and `fillProposal` does default them, but only
 * after binding. Binding needs both ends or an attachment, so a propose that
 * named only its repo was refused with "Name a change, or a base and head"
 * before the defaults were ever read. This fills them for binding alone; the
 * proposal itself still takes them from `fillProposal`, which is what tells
 * the gate they were guessed.
 *
 * An attachment still wins when no repo is named, since naming neither is
 * how a caller proposes to the change already in play.
 */
export async function withCheckoutEnds(
	params: OfferParams,
	cwd: string,
): Promise<OfferParams> {
	if (params.change !== undefined) return params;
	if (params.base !== undefined && params.head !== undefined) return params;
	if (params.repo === undefined && (await attachments().list()).length > 0)
		return params;
	const facts = await checkoutFacts(REVIEW_COMMANDS, params.repo ?? cwd);
	const head = params.head ?? facts.branch;
	const base = params.base ?? facts.parent ?? facts.trunk;
	if (head === undefined || base === undefined) return params;
	return { ...params, head, base };
}

/**
 * The size of what a propose would put up: its head's diff from where it
 * parts with its base, the base read from its remote first. Unknown, with
 * the reason, when the checkout names no ends to compare.
 */
export async function proposalSize(
	params: OfferParams,
	cwd: string,
): Promise<ChangeSize> {
	const ends = await withCheckoutEnds(params, cwd);
	if (ends.base === undefined || ends.head === undefined) {
		return {
			unknown: "this checkout names no base and head to compare, so name both",
		};
	}
	return checkoutSize(
		REVIEW_COMMANDS,
		params.repo ?? cwd,
		[`origin/${ends.base}`, ends.base],
		ends.head,
	);
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
export async function tipSubject(
	host: Pick<ExtensionAPI, "exec">,
	cwd: string,
	branch: string,
): Promise<string | undefined> {
	try {
		const result = await host.exec("git", [
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
