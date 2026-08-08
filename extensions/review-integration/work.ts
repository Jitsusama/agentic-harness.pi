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
 * against the caller's own checkout and is not worth losing to a
 * missing optional dependency.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RepoLocator, TreeRead } from "../../lib/review/index.js";
import { whatItRead } from "../../lib/review/index.js";
import {
	satisfies,
	treeRequestFrom,
	WORK_READY,
	WORK_REQUEST,
	type WorkApi,
} from "../../lib/work/index.js";

/** The working layer, once something has announced one. */
let work: WorkApi | undefined;

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
export function treeStandingFor(
	repo: RepoLocator,
	commit: string | undefined,
): TreeStanding {
	if (work === undefined) {
		return { kind: "unknown", why: "no working layer is loaded" };
	}
	if (commit === undefined) {
		return {
			kind: "unknown",
			why: "this provider does not report the commit under review",
		};
	}

	const asked = treeRequestFrom({
		intent: "snapshot",
		repo: {
			key: repo.key,
			...(repo.localPath === undefined ? {} : { localPath: repo.localPath }),
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
): Promise<RoundTree | { refusal: string }> {
	if (work === undefined) {
		return {
			refusal:
				"No working layer is loaded, so there is nowhere to hand you. " +
				"Load the work integration, or fix this in a tree you cut yourself.",
		};
	}

	const asked = treeRequestFrom({
		intent: "worktree",
		repo: {
			key: repo.key,
			...(repo.localPath === undefined ? {} : { localPath: repo.localPath }),
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

/** Where a round will run, and whether that is what was wanted. */
export type RoundTree =
	| {
			path: string;
			/** Said out loud when the tree is not the commit under review. */
			caveat?: string;
	  }
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
	tree: RoundTree,
	headCommit: string | undefined,
): TreeRead {
	// A refused tree has no round to record anything about. Taking the
	// whole RoundTree rather than the caveat alone is deliberate, so
	// that adding the refusal made every caller a compile error until
	// it decided what to do, which is how the seven sites were found.
	const caveat = "refusal" in tree ? undefined : tree.caveat;
	return whatItRead({
		...(headCommit === undefined ? {} : { witness: headCommit }),
		...(caveat === undefined ? {} : { unpinned: caveat }),
	});
}

/**
 * A tree to review a commit in, falling back to the caller's own.
 *
 * Every failure here degrades rather than refusing, and says so. A
 * council is expensive and a caller's checkout is usually the right
 * tree anyway; what is not acceptable is reviewing the wrong code
 * silently.
 */
export async function treeForRound(
	repo: RepoLocator,
	commit: string | undefined,
	fallback: string,
): Promise<RoundTree> {
	// Before anything else, because this is the one failure a caveat
	// cannot cover. A repo with neither a checkout nor a remote is a
	// repo nothing on this machine can point at, and the thing that
	// makes a fallback plausible, that the caller is sitting in the
	// repo under review, is the same thing that would have given it a
	// local path. So the fallback here is somebody else's repository.
	//
	// Three councils established the price. Asked about a change in
	// one repo from a session sitting in another, they read the
	// session's repo and returned 225 findings about code the change
	// does not contain, at $75.63. Every one of them read plausibly.
	if (repo.localPath === undefined && repo.remoteUrl === undefined) {
		return {
			refusal: `Nothing here knows where ${repo.key} lives, so there is no tree to review it in and the only fallback is ${fallback}, which is a different repository. A round against the wrong repository returns findings that read perfectly and are about nothing. Run this from a checkout of ${repo.key}, or register a provider that knows where it is.`,
		};
	}
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
			...(repo.localPath === undefined ? {} : { localPath: repo.localPath }),
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
