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

import { realpath } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	DiffModel,
	RepoLocator,
	TreeRead,
} from "../../lib/core/review/index.ts";
import { checkoutFor, whatItRead } from "../../lib/core/review/index.ts";
import { sessionSlot } from "../../lib/core/session/index.ts";
import { treeRequestFrom } from "../../lib/core/work/ask.ts";
import type { HeldTree, TreeBroker } from "../../lib/core/work/broker.ts";
import {
	WORK_READY,
	WORK_REQUEST,
	type WorkApi,
} from "../../lib/core/work/events.ts";
import { satisfies } from "../../lib/core/work/tree.ts";
import { REVIEW_COMMANDS } from "./commands.ts";
import { loadReviewConfig } from "./config.ts";

/**
 * How long to wait for git to name a directory's remotes.
 *
 * Reading local config, so a second is generous. It is a bound rather
 * than a budget: the failure it exists for is a git that blocks on a
 * prompt, and waiting on that costs the round it was protecting.
 */
const REMOTE_PROBE_MS = 5_000;

/**
 * What one conversation knows of its working layer.
 *
 * A conversation's own, never the module's: a shared host loads this
 * module once for every conversation in a folder, so a module-level
 * value was the last conversation's. Its start wiped the others' layer
 * and unsubscribed their listener, and the listener it kept held a
 * parked conversation's whole session alive. On plain pi the slot is
 * the one process-wide value, as the module's was.
 */
interface Standing {
	/** The working layer, once something has announced one. */
	work?: WorkApi;
	/**
	 * The host, kept for the one question only a command can answer.
	 *
	 * Which repository a directory is a checkout of is not something a
	 * locator knows: that is the whole reason a round could be run
	 * against somebody else's repo. Asking git is the only honest answer,
	 * and asking is optional, because a caller who cannot ask is a caller
	 * who cannot show the fallback is the right repo either.
	 *
	 * Unattended rather than pi's own exec, whose child shares pi's
	 * terminal and would draw a credential prompt over it.
	 */
	host?: Pick<ExtensionAPI, "exec">;
	/** How to stop listening for it, so listening twice does not stack. */
	stopListening?: () => void;
	/** The config, once something has asked for it. */
	configured?: ReturnType<typeof loadReviewConfig>;
}

const STANDING = "agentic-harness.review.work-layer.v1";

/** This conversation's standing, by the ambient session when hosted. */
function standing(): Standing {
	return sessionSlot<Standing>(STANDING, undefined, () => ({}));
}

/**
 * Listen for the working layer and ask it to announce itself.
 *
 * Both halves are needed and neither is enough: the announcement may
 * already have happened before this extension loaded, and the request
 * may arrive before the host is listening. Load order then decides
 * nothing, which is the point. `runner` is what asks git, and is only
 * worth naming to put a fake in its place.
 */
export function watchForWorkLayer(
	pi: ExtensionAPI,
	runner: Pick<ExtensionAPI, "exec"> = REVIEW_COMMANDS,
): void {
	const mine = standing();
	mine.host = runner;
	// Once. This runs at registration and again on every session start,
	// and the bus outlives a reload, so keeping the old subscription
	// would stack a listener per start until node warns about a leak in
	// the middle of a frame. The stale ones also still answer, which is
	// how a forgotten broker comes back.
	mine.stopListening?.();
	mine.stopListening = pi.events.on(WORK_READY, (api: unknown) => {
		mine.work = api as WorkApi;
	});
	pi.events.emit(WORK_REQUEST, {});
}

/** Forget it, so a reload does not answer with a dead broker. */
export function forgetWorkLayer(): void {
	const mine = standing();
	mine.work = undefined;
	mine.host = undefined;
	// The config too, since a reload is how somebody applies an edit to
	// it, and answering from the copy read before the edit is the one
	// thing a reload is supposed to fix.
	mine.configured = undefined;
	mine.stopListening?.();
	mine.stopListening = undefined;
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
 * Whether a held tree still stands and its use is dated. Dating takes
 * the record's lock and writes it, which a held lock or a full disk
 * refuses. The change is attached by then, so a refusal never fails
 * the attach; it answers that no tree can be named, which names the
 * call that cuts one instead. Answering by the folder would name the
 * one tree a sweep may be taking: the likeliest holder of a record's
 * lock for seconds is another process's sweep judging that very
 * tree, and an undated use leaves it nothing to keep it by. The
 * named call dates the tree under the lock, reusing or recutting it.
 */
async function standsDated(
	broker: Pick<TreeBroker, "used">,
	tree: HeldTree,
): Promise<boolean> {
	try {
		return await broker.used(tree);
	} catch {
		// Undated, so not safe to name: see above.
		return false;
	}
}

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
	const { work } = standing();
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

	const broker = work.broker();
	const already = broker
		.held()
		.find((tree) => satisfies(tree.identity, asked.request));
	// Dated as an ask, since the reader sent there reads by path and
	// leaves no other sign: a snapshot last asked for nearly four hours
	// ago was otherwise taken by a sweep while a review read it. One
	// taken meanwhile answers as none, naming the call that cuts it.
	if (already && (await standsDated(broker, already))) {
		return { kind: "cut", path: already.path };
	}

	// The call itself, spelled out. A reader told only that no tree
	// exists has to go and work out which of nineteen actions makes
	// one, and with which arguments, which is the moment they give up
	// and run git themselves.
	//
	// The whole commit, because this is a command and not a
	// description of one. Abbreviating it read better and did not
	// run: a tree that has to fetch an unmerged head is answered by
	// gitstream with `couldn't find remote ref d99232b14cb8`, which
	// reads as a commit that does not exist rather than one named too
	// short. Anything printed to be pasted has to survive being
	// pasted.
	return {
		kind: "none",
		would: `work snapshot repo:${repo.key} commit:${commit} purpose:review`,
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
	const { work } = standing();
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
	/**
	 * Said out loud when the tree is the commit but some of the change's
	 * files couldn't be put in it. Kept apart from the caveat, since the
	 * tree is the commit, but recorded as unpinned all the same: reviewers
	 * who couldn't find the change didn't read it, so neither gate may
	 * count the round as a read of the head (readFrom).
	 */
	lacking?: string;
}

/**
 * What the session is told about the tree a round read: the caveat
 * and what it lacked, or nothing when it read the commit whole.
 */
export function saidOfTree(tree: ReadableTree): string | undefined {
	const said = [tree.caveat, tree.lacking].filter(
		(line): line is string => line !== undefined,
	);
	return said.length > 0 ? said.join(" ") : undefined;
}

/**
 * The files a round's tree must hold: each a change writes, as it
 * stands at the head, once each.
 *
 * A provider may cut a tree sparse, as World's does, holding only the
 * top-level files and the zones it is asked for. Asked for no files, it
 * handed reviewers a tree without the change in it, so they read
 * nothing of what they were asked about (2MWIBZ, 25 Nov, two World
 * councils). A file the change deletes has no head side to read, and
 * its old path can name a zone the head no longer has, which a provider
 * would refuse, so only the head's paths are asked for.
 */
export function filesToRead(diff: DiffModel): string[] {
	return [
		...new Set(
			diff.files.flatMap((file) =>
				file.newPath === undefined ? [] : [file.newPath],
			),
		),
	];
}

/**
 * The files a stack's tip must hold: each a change in it writes, as it
 * stands at the tip. Read in order, so a file one change writes and a
 * later one deletes or moves away is not asked of the tip, which lacks
 * it, and whose absence would have the provider refuse every file.
 */
export function stackFilesToRead(diffs: readonly DiffModel[]): string[] {
	const held = new Set<string>();
	for (const diff of diffs) {
		for (const file of diff.files) {
			if (file.oldPath !== undefined && file.oldPath !== file.newPath) {
				held.delete(file.oldPath);
			}
			if (file.newPath !== undefined) held.add(file.newPath);
		}
	}
	return [...held];
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
	baseCommit: string | undefined,
): TreeRead {
	// A readable tree only. Widening this to the union let a refused
	// tree be recorded as a round that read the commit faithfully,
	// which is the opposite of what a refusal means, and it weakened
	// the one compile-time guarantee this change relies on.
	const unpinned = unpinnedOf(tree);
	return whatItRead({
		...(headCommit === undefined ? {} : { witness: headCommit }),
		...(unpinned === undefined ? {} : { unpinned }),
		...(baseCommit === undefined ? {} : { from: baseCommit }),
	});
}

/**
 * Why a round on `tree` is not a read of the head, or nothing when it
 * is: the tree is another commit, or it lacks the change's files.
 */
export function unpinnedOf(tree: ReadableTree): string | undefined {
	return tree.caveat ?? tree.lacking;
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
	const mine = standing();
	mine.configured ??= loadReviewConfig();
	const { config } = await mine.configured;
	return checkoutFor(repo.key, config);
}

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
	const { host } = standing();
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
 * The commit a directory has checked out, or undefined when git will
 * not say. Undefined is treated as not the commit, since a tree we
 * cannot vouch for is the case a refusal is for.
 */
async function headOf(directory: string): Promise<string | undefined> {
	const { host } = standing();
	if (host === undefined) return undefined;
	try {
		const said = await host.exec(
			"git",
			["-C", directory, "rev-parse", "HEAD"],
			{
				timeout: REMOTE_PROBE_MS,
			},
		);
		return said.code === 0 ? said.stdout.trim() || undefined : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether a directory is the top of its checkout rather than a folder
 * inside one: a round reads the folder it is given as the repo's root,
 * so a subfolder, tracked or ignored, would be read as the whole
 * commit while holding a part of it or none.
 */
async function isTopOfCheckout(directory: string): Promise<boolean> {
	const { host } = standing();
	if (host === undefined) return false;
	try {
		const said = await host.exec(
			"git",
			["-C", directory, "rev-parse", "--show-toplevel"],
			{ timeout: REMOTE_PROBE_MS },
		);
		if (said.code !== 0) return false;
		return said.stdout.trim() === (await realpath(directory));
	} catch {
		// A folder git or the filesystem won't resolve can't be shown to
		// be a checkout's top, so it is not read as one.
		return false;
	}
}

/**
 * Whether a directory's tracked files are as its HEAD has them, by
 * asking git; undefined when git couldn't say, so a refusal doesn't
 * claim edits nobody saw. Untracked files are left out: a checkout
 * routinely holds scratch nobody added, and a reviewer reading one is
 * told the diff, which they are not in.
 *
 * Asked without optional locks and with the repo's fsmonitor off, so
 * reading a checkout the caller named neither takes its index lock
 * nor runs a command its config names.
 */
async function isClean(directory: string): Promise<boolean | undefined> {
	const { host } = standing();
	if (host === undefined) return undefined;
	try {
		const said = await host.exec(
			"git",
			[
				"--no-optional-locks",
				"-c",
				"core.fsmonitor=false",
				"-C",
				directory,
				"status",
				"--porcelain",
				"--untracked-files=no",
			],
			{ timeout: REMOTE_PROBE_MS },
		);
		// A status the clock killed printed only part of what it found, so
		// what it printed says nothing about the rest.
		if (said.code !== 0 || said.killed) return undefined;
		return said.stdout.trim() === "";
	} catch {
		// A git that will not run cannot vouch for the tree, and a round
		// is refused rather than reading what nobody vouched for.
		return undefined;
	}
}

/**
 * Whether a checkout can stand in for the commit: undefined when its
 * HEAD is the commit and its tracked files are unchanged, or else how
 * it stands, said for a refusal.
 */
async function standingApart(
	directory: string,
	commit: string,
): Promise<string | undefined> {
	const head = await headOf(directory);
	if (head === undefined) return "is at a commit git would not name";
	if (!head.startsWith(commit)) {
		return `is at ${head.slice(0, 12)} rather than ${commit}`;
	}
	if (!(await isTopOfCheckout(directory))) {
		return "is a folder inside a checkout, not the top of one";
	}
	const clean = await isClean(directory);
	if (clean === undefined) {
		return `is at ${commit}, but git couldn't say whether its tracked files are unchanged`;
	}
	return clean
		? undefined
		: `is at ${commit} with uncommitted changes to tracked files`;
}

/**
 * Where a round goes when no tree could be cut at the commit: the
 * ground when it stands cleanly at that commit, then the checkout the
 * caller named when git says it is this repo and it stands cleanly at
 * the commit, and otherwise a refusal naming each and how it stands.
 *
 * The named checkout is the repo parameter when one was given and the
 * session's own directory when not, which is the same directory the
 * ground falls back to with no checkout configured.
 *
 * The named checkout is tried second, not ignored. The ground is the
 * configured checkout whenever one is configured, which is right for
 * cutting a snapshot, and the refusal's own advice is to name a
 * checkout that has the commit. A caller who did exactly that was
 * refused anyway, with the configured path in the message and the one
 * it named nowhere (XY9H5C, 21 Nov, core.nix's PR read from a tree).
 *
 * This used to read the fallback at whatever commit it stood on, with
 * a caveat. Two councils did that and returned fifty-nine findings
 * about a checkout that was not the change, and a caveat does not stop
 * a finding being acted on. The usual cause, a commit nobody had
 * fetched, went away when snapshots learned to fetch one, so what is
 * left is rare and worth stopping for.
 */
async function fallbackAt(
	choice: { repo: RepoLocator; ground: string; named: string },
	commit: string,
	why: string,
): Promise<RoundTree> {
	const { repo, ground, named } = choice;
	const groundApart = await standingApart(ground, commit);
	if (groundApart === undefined) return { path: ground };
	let namedApart = "";
	if (named !== ground) {
		if (await isCheckoutOf(named, repo)) {
			const apart = await standingApart(named, commit);
			if (apart === undefined) return { path: named };
			namedApart = ` The checkout it was pointed at (the repo parameter, else the session's folder), ${named}, ${apart}.`;
		} else {
			namedApart = ` The checkout it was pointed at (the repo parameter, else the session's folder), ${named}, is not a checkout of ${repo.key}.`;
		}
	}
	return {
		refusal: `${why} The checkout left to read, ${ground}, ${groundApart}, and findings about other code read as plausibly as real ones.${namedApart} Fetch ${commit} there or check it out cleanly, or name a checkout that has it as the repo parameter, then ask again.`,
	};
}

/**
 * A tree to review a commit in, or a refusal.
 *
 * A tree pinned to the commit is the aim. Where none can be cut, the
 * caller's checkout is read only when it is at that commit already;
 * otherwise the round is refused with the way to fix it. Where the
 * provider names no commit at all there is nothing to compare, so the
 * checkout is read with a caveat saying so.
 *
 * Being in the wrong repository is settled first, and refused, because
 * no checkout of another project is worth reading.
 */
export async function treeForRound(
	repo: RepoLocator,
	commit: string | undefined,
	fallback: string,
	// Required, so a round that forgets its change's files fails to
	// compile rather than reading a tree without them.
	files: readonly string[],
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
	const choice = { repo, ground: ground.path, named: fallback };
	fallback = ground.path;

	if (commit === undefined) {
		return {
			path: fallback,
			caveat: `This provider does not report the commit under review, so there is nothing to pin a tree to and reviewers read ${fallback} instead.`,
		};
	}
	const { work } = standing();
	if (work === undefined) {
		return fallbackAt(
			choice,
			commit,
			"No working layer is loaded to cut a tree at the commit under review; load the work integration to have one cut.",
		);
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
		...(files.length > 0 ? { paths: files } : {}),
	});
	if ("refusal" in asked) return fallbackAt(choice, commit, asked.refusal);

	const broker = work.broker();
	try {
		const held = await broker.ensure(asked.request);
		return { path: held.path };
	} catch (error) {
		const why = error instanceof Error ? error.message : String(error);
		if (asked.request.intent !== "snapshot" || files.length === 0) {
			return fallbackAt(choice, commit, why);
		}
		// Asked once more for the commit alone. A provider refusing the
		// files (World's, for a file in no zone) still has the commit to
		// give, and a round at the commit without some files reads more
		// than one refused, or one sent to a checkout at another commit.
		const { paths: _files, ...whole } = asked.request;
		try {
			const held = await broker.ensure(whole);
			return {
				path: held.path,
				lacking: `The tree couldn't be cut holding the change's files (${why}), so it was cut at the commit alone, and reviewers may not find them; the round doesn't count as a read of the head.`,
			};
		} catch (again) {
			return fallbackAt(
				choice,
				commit,
				again instanceof Error ? again.message : String(again),
			);
		}
	}
}
