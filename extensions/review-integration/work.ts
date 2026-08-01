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
import type { RepoLocator } from "../../lib/review/index.js";
import {
	satisfies,
	treeRequestFrom,
	WORK_READY,
	WORK_REQUEST,
	type WorkApi,
} from "../../lib/work/index.js";

/** The working layer, once something has announced one. */
let work: WorkApi | undefined;

/**
 * Listen for the working layer and ask it to announce itself.
 *
 * Both halves are needed and neither is enough: the announcement may
 * already have happened before this extension loaded, and the request
 * may arrive before the host is listening. Load order then decides
 * nothing, which is the point.
 */
export function watchForWorkLayer(pi: ExtensionAPI): void {
	pi.events.on(WORK_READY, (api: unknown) => {
		work = api as WorkApi;
	});
	pi.events.emit(WORK_REQUEST, {});
}

/** Forget it, so a reload does not answer with a dead broker. */
export function forgetWorkLayer(): void {
	work = undefined;
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

/** Where a round will run, and whether that is what was wanted. */
export interface RoundTree {
	path: string;
	/** Said out loud when the tree is not the commit under review. */
	caveat?: string;
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
