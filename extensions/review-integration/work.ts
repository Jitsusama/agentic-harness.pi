/**
 * Reaching the working layer, when something hosts one.
 *
 * A reviewer needs a tree to read. It should not be whatever
 * directory the session happens to sit in, because a change that is
 * not checked out there gets reviewed against unrelated code and the
 * answer looks perfectly plausible.
 *
 * What it wants is a **snapshot**: pinned to the commit under review,
 * never written to, and shareable, so six reviewers reading the same
 * commit share one tree rather than cutting six. That is exactly the
 * distinction `lib/work` draws between a snapshot and a worktree, and
 * the reason a snapshot's identity excludes nothing but its paths.
 *
 * The seam is the event bus, so this package needs the work library
 * and never the work extension. If nothing answers, asking still
 * succeeds and says it fell back, because a round is worth running
 * against a checkout of the right repo and is not worth losing to a
 * missing optional dependency.
 *
 * Falling back has one limit, and it is not about the commit. A
 * directory that is a checkout of some other project is not a worse
 * tree, it is a different subject, so a round with nowhere honest to
 * stand refuses instead of degrading.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RepoLocator, TreeRead } from "../../lib/review/index.js";
import { checkoutFor, whatItRead } from "../../lib/review/index.js";
import {
	satisfies,
	treeRequestFrom,
	WORK_READY,
	WORK_REQUEST,
	type WorkApi,
} from "../../lib/work/index.js";
import { loadReviewConfig } from "./config.js";

/**
 * How long to wait for git to name a directory's remotes.
 *
 * Reading local config, so a second is generous. It is a bound rather
 * than a budget: the failure it exists for is a git that blocks on a
 * prompt, and waiting on that costs the round it was protecting.
 */
const REMOTE_PROBE_MS = 5_000;

/** The working layer, once something has announced one. */
let work: WorkApi | undefined;

/**
 * The host, kept for the one question only a command can answer.
 *
 * Which repository a directory is a checkout of is not something a
 * locator knows: that is the whole reason a round could be run
 * against somebody else's repo. Asking git is the only honest answer,
 * and asking is optional, because a caller who cannot ask is a caller
 * who cannot show the fallback is the right repo either.
 */
let host: ExtensionAPI | undefined;

/** How to stop listening for it, so listening twice does not stack. */
let stopListening: (() => void) | undefined;

/**
 * Listen for the working layer and ask it to announce itself.
 *
 * Both halves are needed and neither is enough: the announcement may
 * already have happened before this extension loaded, and the request
 * may arrive before the host is listening. Load order then decides
 * nothing, which is the point.
 */
export function watchForWorkLayer(pi: ExtensionAPI): void {
	host = pi;
	// Once. This runs at registration and again on every session start,
	// and the bus outlives a reload, so keeping the old subscription
	// would stack a listener per start until node warns about a leak in
	// the middle of a frame. The stale ones also still answer, which is
	// how a forgotten broker comes back.
	stopListening?.();
	stopListening = pi.events.on(WORK_READY, (api: unknown) => {
		work = api as WorkApi;
	});
	pi.events.emit(WORK_REQUEST, {});
}

/** Forget it, so a reload does not answer with a dead broker. */
export function forgetWorkLayer(): void {
	work = undefined;
	host = undefined;
	// The config too, since a reload is how somebody applies an edit to
	// it, and answering from the copy read before the edit is the one
	// thing a reload is supposed to fix.
	configured = undefined;
	stopListening?.();
	stopListening = undefined;
}

/** Whether a change already has somewhere to read it. */
export type TreeStanding =
	/** One is cut and pinned to this commit. */
	| { kind: "cut"; path: string }
	/** None is, and this is the call that would make one. */
	| { kind: "none"; would: string }
	/** Nothing can say, because there is no working layer or no commit. */
	| { kind: "unknown"; why: string };

/**
 * Whether a tree is already cut for this change, cutting nothing.
 *
 * Attaching a change must not build a tree. A World tree costs
 * minutes, and most of the time only the diff is wanted, so paying
 * for one at attach time bills every reader for what few of them
 * need. What attaching can do is say where things stand and name the
 * call that would change it, which is the difference between a slow
 * surprise and a choice.
 */
export async function treeStandingFor(
	repo: RepoLocator,
	commit: string | undefined,
): Promise<TreeStanding> {
	if (work === undefined) {
		return { kind: "unknown", why: "no working layer is loaded" };
	}
	if (commit === undefined) {
		return {
			kind: "unknown",
			why: "this provider does not report the commit under review",
		};
	}

	// The configured checkout too, so attaching a cross-repo change
	// reports where it stands rather than refusing to say. Without it
	// this answered "nothing can be told" for exactly the repos the
	// config had just made reviewable.
	const known = repo.localPath ?? (await configuredCheckout(repo));
	const asked = treeRequestFrom({
		intent: "snapshot",
		repo: {
			key: repo.key,
			...(known === undefined ? {} : { localPath: known }),
			...(repo.remoteUrl === undefined ? {} : { remoteUrl: repo.remoteUrl }),
		},
		purpose: "review",
		commit,
	});
	if ("refusal" in asked) return { kind: "unknown", why: asked.refusal };

	const already = work
		.broker()
		.held()
		.find((tree) => satisfies(tree.identity, asked.request));
	if (already) return { kind: "cut", path: already.path };

	// The call itself, spelled out. A reader told only that no tree
	// exists has to go and work out which of nineteen actions makes
	// one, and with which arguments, which is the moment they give up
	// and run git themselves.
	return {
		kind: "none",
		would: `work snapshot repo:${repo.key} commit:${commit.slice(0, 12)} purpose:review`,
	};
}

/**
 * Somewhere to fix the next item, cut if it is not there yet.
 *
 * Provisioning is eager here and lazy at attach time, and the line
 * between them is whether asking for the thing is already asking for
 * a tree. Reading a change wants a diff, which the provider serves
 * without one. Being handed the next thing to fix wants a working
 * directory, and there is no cheaper substitute: sending somebody off
 * to cut their own is the last mile nobody walks.
 *
 * One tree serves every item on a change, not one per item. A
 * worktree's identity is its repo and branch, so the broker reuses
 * the same tree for the second finding as for the first, which is
 * also just true of the work: you fix them all on the one branch.
 */
export async function treeForFixing(
	repo: RepoLocator,
	branch: string,
): Promise<{ path: string } | { refusal: string }> {
	if (work === undefined) {
		return {
			refusal:
				"No working layer is loaded, so there is nowhere to hand you. " +
				"Load the work integration, or fix this in a tree you cut yourself.",
		};
	}

	const known = repo.localPath ?? (await configuredCheckout(repo));
	const asked = treeRequestFrom({
		intent: "worktree",
		repo: {
			key: repo.key,
			...(known === undefined ? {} : { localPath: known }),
			...(repo.remoteUrl === undefined ? {} : { remoteUrl: repo.remoteUrl }),
		},
		purpose: "fix",
		branch,
	});
	if ("refusal" in asked) return { refusal: asked.refusal };

	try {
		const held = await work.broker().ensure(asked.request);
		return { path: held.path };
	} catch (error) {
		// Reported rather than thrown, because the item is still worth
		// handing over. Somebody who knows what to fix and has to find
		// their own directory is inconvenienced; somebody shown an error
		// instead of the item has lost the thing they asked for.
		return {
			refusal: error instanceof Error ? error.message : String(error),
		};
	}
}

/** A tree a round can actually read, wanted or merely acceptable. */
export interface ReadableTree {
	path: string;
	/** Said out loud when the tree is not the commit under review. */
	caveat?: string;
}

/** Where a round will run, and whether that is what was wanted. */
export type RoundTree =
	| ReadableTree
	| {
			/**
			 * Why no round should be run at all.
			 *
			 * Degrading is right when the fallback is the repo under
			 * review at some other commit, and worthless when it is a
			 * different repository. The second is not a worse review, it
			 * is a review of something else.
			 */
			refusal: string;
	  };

/**
 * What a round formed here read, in the shape a run records it.
 *
 * The pairing is the point. Every round records the commit under
 * review, and a round that fell back to the caller's checkout records
 * one too, so a witness written without the caveat beside it says the
 * reviewers read a change they were never given. The caveat used to
 * go only to the session that started the round, which left the
 * durable record confidently wrong and told a later collector
 * nothing.
 *
 * It is not hypothetical. Two councils fell back because a worktree of
 * that name already existed, and between them returned fifty-nine
 * findings formed against whatever the checkout happened to be.
 */
export function readFrom(
	tree: ReadableTree,
	headCommit: string | undefined,
): TreeRead {
	// A readable tree only. Widening this to the union let a refused
	// tree be recorded as a round that read the commit faithfully,
	// which is the opposite of what a refusal means, and it weakened
	// the one compile-time guarantee this change relies on.
	return whatItRead({
		...(headCommit === undefined ? {} : { witness: headCommit }),
		...(tree.caveat === undefined ? {} : { unpinned: tree.caveat }),
	});
}

/**
 * Where a degraded round may read, or why it may not run.
 *
 * The fault is a relation between two things, not a property of one:
 * the question is whether the ground the reviewers would stand on is
 * the repo under review. Asking the locator instead let two shapes
 * through. A repo known only by remote still fell back to whatever
 * the caller was sitting in, and a repo known only by key refused
 * even when the caller was standing in it.
 *
 * A checkout we know about wins over the caller's own directory,
 * since it is the right repo by construction and the caller's
 * directory is only ever right by luck.
 */
async function groundFor(
	repo: RepoLocator,
	fallback: string,
): Promise<{ path: string } | { refusal: string }> {
	if (repo.localPath !== undefined) return { path: repo.localPath };
	// Asked the same question the caller's own directory is asked, and
	// it is not a formality. A mapping matches by substring, so a loose
	// one names a sibling repo, and a path goes stale the day somebody
	// moves a checkout. Trusting it unchecked would put the one thing
	// this function exists to prevent behind a config edit: a round
	// reading a different project and returning findings that read
	// perfectly and are about nothing.
	const configured = await configuredCheckout(repo);
	if (configured !== undefined && (await isCheckoutOf(configured, repo))) {
		return { path: configured };
	}
	if (await isCheckoutOf(fallback, repo)) return { path: fallback };
	if (configured !== undefined) {
		return {
			refusal: `The review config points ${repo.key} at ${configured}, and git does not say that is a checkout of it, so a round there would read a different project. Findings from the wrong repository read perfectly and are about nothing. Correct the path, or run this from a checkout of ${repo.key}.`,
		};
	}
	return {
		refusal: `${fallback} is not a checkout of ${repo.key}, and nothing here knows where that repo lives, so a round would read a different project. Findings from the wrong repository read perfectly and are about nothing. Run this from a checkout of ${repo.key}, or add it to the review config: a repo mapping matching ${repo.key} with a path naming its checkout.`,
	};
}

/**
 * Where the config says this repo is checked out.
 *
 * The answer to the one question nothing else on this machine can
 * answer. Without it the only reviewable repo is the one the session
 * happens to sit in, which is how a change in a second repo goes
 * unreviewed for a week: every round from here reads the wrong
 * project, and since that was stopped, refuses instead.
 *
 * Read once and kept. It is a file a person edits between sessions,
 * and re-reading it per round buys nothing.
 */
async function configuredCheckout(
	repo: RepoLocator,
): Promise<string | undefined> {
	configured ??= loadReviewConfig();
	const { config } = await configured;
	return checkoutFor(repo.key, config);
}

/** The config, once something has asked for it. */
let configured: ReturnType<typeof loadReviewConfig> | undefined;

/**
 * Whether a directory is a checkout of this repo, by asking git.
 *
 * Matched on the owner and name the key carries rather than on a URL
 * verbatim, because the same repo is reached by ssh and by https and
 * is named two ways by two hosts. A caller with no host to ask
 * answers no, which is right: it cannot show the fallback is the repo
 * either.
 */
async function isCheckoutOf(
	directory: string,
	repo: RepoLocator,
): Promise<boolean> {
	const named = repo.key.split(":").pop();
	if (named === undefined || named === "") return false;
	if (host === undefined) return false;
	try {
		const said = await host.exec("git", ["-C", directory, "remote", "-v"], {
			timeout: REMOTE_PROBE_MS,
		});
		if (said.code !== 0) return false;
		const wanted = named.toLowerCase();
		return said.stdout
			.toLowerCase()
			.split("\n")
			.some((line) => line.includes(wanted) || line.includes(`${wanted}.git`));
	} catch {
		// A directory that is not a repository, or a git that will not
		// run. Either way we cannot show this is the right repo, and
		// saying so is the safe answer rather than the optimistic one.
		return false;
	}
}

/**
 * A tree to review a commit in, falling back to the caller's own.
 *
 * Every failure about the commit degrades rather than refusing, and
 * says so. A council is expensive and a checkout of the right repo is
 * usually close enough; what is not acceptable is reviewing the wrong
 * code silently.
 *
 * Being in the wrong repository is not one of those failures. That is
 * settled first, and refused, because no caveat makes findings about
 * another project worth reading.
 */
export async function treeForRound(
	repo: RepoLocator,
	commit: string | undefined,
	fallback: string,
): Promise<RoundTree> {
	// Where a degraded round may honestly read, decided before
	// anything is cut, because this is the one failure a caveat cannot
	// cover: a caveat about the commit is no use when the tree is
	// another project.
	//
	// Three councils established the price. Asked about a change in
	// one repo from a session sitting in another, they read the
	// session's repo and returned 225 findings about code the change
	// does not contain, at $75.63. Every one of them read plausibly.
	const ground = await groundFor(repo, fallback);
	if ("refusal" in ground) return ground;
	fallback = ground.path;

	if (work === undefined) {
		return {
			path: fallback,
			caveat: `No working layer is loaded, so reviewers read ${fallback} rather than a tree pinned to the commit under review. Load the work integration to have one cut.`,
		};
	}
	if (commit === undefined) {
		return {
			path: fallback,
			caveat: `This provider does not report the commit under review, so there is nothing to pin a tree to and reviewers read ${fallback} instead.`,
		};
	}

	const asked = treeRequestFrom({
		intent: "snapshot",
		// Both locators pass through: a provider that knows only a
		// remote gets a refusal naming the missing checkout rather
		// than a ten-minute clone nobody asked for, which is the
		// working layer's own rule and not this module's to soften.
		repo: {
			key: repo.key,
			// The ground, which is the locator's path when it had one and
			// otherwise the checkout that was found for it. Passing only
			// the locator's own is what made a cross-repo round degrade
			// even once its checkout was known: right repo, wrong commit,
			// when a snapshot at the right commit was available.
			localPath: fallback,
			...(repo.remoteUrl === undefined ? {} : { remoteUrl: repo.remoteUrl }),
		},
		purpose: "review",
		commit,
	});
	if ("refusal" in asked) {
		return {
			path: fallback,
			caveat: `${asked.refusal} Reviewers read ${fallback} instead.`,
		};
	}

	try {
		const held = await work.broker().ensure(asked.request);
		return { path: held.path };
	} catch (error) {
		return {
			path: fallback,
			caveat: `${error instanceof Error ? error.message : String(error)} Reviewers read ${fallback} instead.`,
		};
	}
}
