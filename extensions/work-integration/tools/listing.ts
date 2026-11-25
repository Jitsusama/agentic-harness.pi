/**
 * The trees this session holds, listed, and one given back: refused while
 * it holds uncommitted work, or when a quest holds it, or when the
 * provider that cut it isn't here to remove it; set aside whole when git
 * won't run in it to say what it holds.
 */

import { existsSync, lstatSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { citeListing } from "../../../lib/core/result/listing.ts";
import { openSessionStore } from "../../../lib/core/result/location.ts";
import type { HeldTree, TreeBroker } from "../../../lib/core/work/broker.ts";
import {
	blocksRepoint,
	type WorkHistory,
} from "../../../lib/core/work/history.ts";
import { RecordWent } from "../../../lib/core/work/memory.ts";
import { readPlain } from "../../../lib/core/work/plain-file.ts";
import {
	GUARD_WORDS,
	HAND_LOCKED,
	handLocked,
	plainWords,
	StuckAside,
	setAsideWhole,
	strandedDir,
} from "../../../lib/core/work/stranded.ts";
import {
	branchesKeptForSession,
	KEPT_BRANCHES,
	type KeptBranch,
} from "../../../lib/core/work/sweep-kept-branches.ts";
import { gitRules } from "../../../lib/internal/sandbox/sandbox.ts";
import {
	gitRun,
	namedGitFolder,
	real,
	within,
} from "../../../lib/internal/sandbox/tree-git.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { treeDir } from "../broker.ts";
import { GLYPH, treeLine } from "../render.ts";
import { sweepLockPath } from "../sweep.ts";
import { CLAIMED_PROVIDER } from "./held.ts";
import { type Answer, refuse, say } from "./shared.ts";

/**
 * The held trees that still stand, with the use of each this session
 * holds dated. A listing is how a reader finds a path to read by, and a
 * reader by path leaves no other sign, so a sweep would take a snapshot
 * read hours after it was cut. One a sweep took meanwhile is left out.
 * One whose dating is refused is still listed, since it is still held
 * and a listing never fails for its dating.
 *
 * Only this session's own are dated: those it cut, and those whose
 * records name it, as a session resumed after a restart holds its
 * own. The broker lists every tree recorded on the machine, and dating
 * one holds it, so dating them all made the lister an owner of every
 * tree, which no sweep could then take; and each dating reads the
 * whole record folder.
 */
export async function datedHeld(
	broker: Pick<TreeBroker, "used" | "heldHere">,
	held: readonly HeldTree[],
): Promise<HeldTree[]> {
	const ours = await broker.heldHere(held).catch(() => new Set<string>());
	const standing = await Promise.all(
		held.map(async (tree) => {
			if (!ours.has(tree.path)) return tree;
			try {
				return (await broker.used(tree)) ? tree : undefined;
			} catch {
				// Refused, as a held lock or a full disk does: still ours.
				return tree;
			}
		}),
	);
	return standing.filter((tree) => tree !== undefined);
}

/**
 * What to say of the worktrees the sweep took from this session, unused
 * a day with nothing only there: each branch at the head it kept, and
 * how to have it again. Nothing when none went.
 */
export function takenWhileIdle(went: readonly KeptBranch[]): string {
	if (went.length === 0) return "";
	const each = went
		.map((one) => `${one.branch} at ${one.commit.slice(0, 12)}`)
		.join(", ");
	return `${GLYPH.named} Taken while unused a day, nothing only there, each branch kept at its head: ${each}. Ask with action 'tree' and its branch to have one again as it was.`;
}

/** List the trees the broker holds, one line each, dating each use. */
export async function listHeld(
	broker: TreeBroker,
	ctx: ExtensionContext,
): Promise<Answer> {
	const held = await datedHeld(broker, broker.held());
	const session = ctx.sessionManager?.getSessionId?.();
	const went =
		session === undefined
			? ""
			: takenWhileIdle(
					branchesKeptForSession(
						join(dirname(sweepLockPath()), KEPT_BRANCHES),
						session,
					),
				);
	if (held.length === 0) {
		return say(
			`${GLYPH.named} No trees held. Ask for one with action 'tree' or 'snapshot'.${went === "" ? "" : `\n${went}`}`,
			{ ok: true, held: 0 },
		);
	}
	return say(
		citeListing(openSessionStore(ctx), {
			// First, so a long listing's budget never cuts the telling off on
			// the machines holding the most trees, where it matters most.
			view: [
				...(went === "" ? [] : [went]),
				...held.map((one) => treeLine(one, broker.cutHere(one.path))),
			].join("\n"),
			records: [...held],
			unit: "trees",
			narrowing: "Query the stored result for the trees you need.",
		}),
		{ ok: true, held: held.length },
	);
}

/** Give a held tree back, once nothing in it would be lost. */
export async function releaseTree(
	broker: TreeBroker,
	history: WorkHistory,
	found: HeldTree,
	signal: AbortSignal | undefined,
): Promise<Answer> {
	// A tree a quest holds goes back through the quest, which
	// keeps its record and knows what pruning it means.
	if (found.providerId === CLAIMED_PROVIDER) {
		return refuse(
			`${GLYPH.refused} ${found.path} is held by a quest, not by this tool. Give it back with quest tree-release, passing it as cwd.`,
		);
	}

	// Git won't run in it, so neither its status nor its provider's
	// removal can, and it had no way back but by hand. Only a tree cut
	// where this tool cuts them, and refused for itself rather than for
	// a repository above it: another provider's tree is its provider's
	// to take down, which a move behind its back would leave naming a
	// folder that is gone.
	const unread = unreadHere(found.path);
	if (unread?.kind === "away") {
		const where = displayPath(found.path);
		// The folder its .git names is a command's to choose, so it is
		// never said back; the checkout to repair from is wherever it
		// stands now, not where that .git says.
		return refuse(
			`${GLYPH.refused} Git won't run in ${where}: its .git names a worktree's git folder whose repository isn't there, as when the checkout that cut it moved or its volume isn't mounted. It is still there and still held. Mount its volume, or run \`git worktree repair ${found.path}\` from the checkout you cut it from where that stands now, never from a folder its .git names, which a sandboxed command could have written; then release it again. If that checkout is gone for good, move the tree aside by hand.`,
		);
	}
	if (unread !== undefined) {
		return await setUnreadAside(broker, found, unread.refused);
	}

	// The work inside is the caller's, and losing it is not
	// recoverable, so the same sentence that guards a repoint
	// guards this.
	const state = await history.status(found.path);
	const blocked = blocksRepoint(state);
	if (blocked) {
		return refuse(`${GLYPH.refused} ${blocked}`);
	}
	const gone = await broker.release(found, signal ? { signal } : {});
	if (gone.kind === "no-provider") {
		// Said as a refusal because nothing happened. This used to
		// report success, leaving a tree on disk, tracked by git, with
		// its record dropped and nothing able to name it again.
		const who =
			gone.registered.length === 0
				? "none are registered"
				: gone.registered.join(", ");
		return refuse(
			`${GLYPH.refused} ${found.identity.key} was cut by ${gone.wanted}, which is not registered here, so nothing can remove it. Registered: ${who}. The tree is still at ${displayPath(gone.path)} and still listed, so this can be retried once that provider loads.`,
		);
	}
	return say(`${GLYPH.named} Released ${found.identity.key}.`, {
		ok: true,
		released: found.identity.key,
	});
}

/** Why a tree this tool cut is one git won't run in for itself. */
type Unread =
	/** Git's reason, to say beside the set-aside. */
	| { kind: "unread"; refused: string }
	/** Its `.git` names a worktree's git folder, `own`, that is away. */
	| { kind: "away" };

/**
 * Why git won't run in `path`, when it is a tree this tool cut that git
 * won't run in for itself, as opposed to one whose refusal comes from a
 * repository above it or one another provider cut somewhere else, or
 * nothing. A tree whose `.git` names a worktree's git folder that isn't
 * there, or whose repository isn't, is away rather than unread: the
 * checkout that cut it moved, or its volume isn't mounted, and `git
 * worktree repair` from where it is now brings the tree back, which a
 * move into the stranded folder would undo.
 */
function unreadHere(path: string): Unread | undefined {
	const run = gitRun(path, [], gitRules());
	if (!("refused" in run)) return undefined;
	if (real(run.top) !== real(path) || !within(path, treeDir())) {
		return undefined;
	}
	if (isAway(path)) return { kind: "away" };
	return { kind: "unread", refused: refusalWords(run.refused) };
}

/**
 * The guard's refusals, each in fixed words that name no path. Some of
 * its own name a folder a command in the tree could choose, so they are
 * never said back; reclaim keeps the same rule.
 */
const REFUSALS: readonly (readonly [RegExp, string])[] = [
	[
		/ holds a commondir, which would have git read the settings of another folder/,
		"its git folder holds a commondir, which would have git read the settings of another folder, so git won't run there",
	],
	[
		/'s \.git is a link, which pi won't follow outside the sandbox/,
		"its .git is a link, which pi won't follow outside the sandbox: git would run whatever settings it leads to",
	],
	[
		/ lies where the work tool cuts trees but holds no \.git, as when a command removed it/,
		"it lies where the work tool cuts trees but holds no .git, as when a command removed it, so git won't run there: a .git put back later could name a git folder of a command's own",
	],
	[
		/ lies where the work tool cuts trees but holds a repository of its own/,
		"it lies where the work tool cuts trees but holds a repository of its own rather than a worktree, so git won't run there",
	],
	[
		/'s \.git file names no worktree whose repository names it back/,
		"its .git file names no worktree whose repository names it back, so git won't run there: a command may have pointed it at a git folder of its own",
	],
	[
		/ is a worktree of .*, which the sandbox doesn't keep read-only/s,
		"it is a worktree of a repository the sandbox doesn't keep read-only, so a sandboxed command could have set what git runs there, and pi runs git outside the sandbox",
	],
	[
		/ is a repository the sandbox doesn't keep read-only/,
		"it is a repository the sandbox doesn't keep read-only, so a sandboxed command could have set what git runs there, and pi runs git outside the sandbox",
	],
];

/** What the guard's refusal says, in words of its kind alone. */
function refusalWords(refused: string): string {
	const kind = REFUSALS.find(([shape]) => shape.test(refused));
	return kind === undefined ? GUARD_WORDS : kind[1];
}

/**
 * Whether the `.git` file at `path` names a worktree's git folder, shaped
 * as `<repository>/worktrees/<name>`, whose repository's objects aren't
 * there, as when the checkout moved or its volume isn't mounted. An
 * entry gone from a repository that stands was pruned or removed, which
 * a repair can't bring back, and a `.git` naming any other folder is no
 * tree a repair could mend: both are set aside. Objects that are a link
 * to a folder stand, as the guard reads them, as `git-new-workdir` or an
 * objects folder moved to another disk leaves them.
 */
function isAway(path: string): boolean {
	const own = namedGitFolder(path);
	if (own === undefined || basename(dirname(own)) !== "worktrees") {
		return false;
	}
	return !standsAsFolder(join(dirname(dirname(own)), "objects"));
}

/** What a tree's `.git` was, as far as saying where its commits are. */
type GitShape =
	/** A file naming a worktree entry that stands: its branch is the clone's. */
	| "entry"
	/** A repository of its own, or a link to one: its commits are in it. */
	| "repository"
	/** Nothing at all, so nothing was renamed. */
	| "none"
	/** Anything else, whose commits may be wherever it led. */
	| "unknown";

/**
 * What the tree at `path` has at `.git`, read without running git: a
 * link is followed only to say what it leads to, never by git.
 */
function gitShape(path: string): GitShape {
	const dotGit = join(path, ".git");
	if (isFolder(dotGit)) return "repository";
	if (!standsAt(dotGit)) return "none";
	try {
		if (lstatSync(dotGit).isSymbolicLink()) {
			// Only a repository inside the tree goes aside with it; one a
			// link leads out to keeps its commits where it stands, which
			// can't be told from here.
			const led = statSync(dotGit);
			return led.isDirectory() &&
				existsSync(join(dotGit, "objects")) &&
				within(dotGit, path)
				? "repository"
				: "unknown";
		}
	} catch {
		// A link that leads nowhere, or can't be looked at: its commits
		// can't be placed.
		return "unknown";
	}
	// Only an entry that names this tree back is its own, whose branch
	// the clone keeps; a `.git` may name anybody's, and a repository laid
	// out inside the tree goes aside with it, keeping no branch anywhere.
	const own = namedGitFolder(path);
	if (own === undefined || basename(dirname(own)) !== "worktrees") {
		return "unknown";
	}
	// Git takes the repository from the entry's commondir, so only one
	// naming the repository it lies in, outside the tree and standing,
	// keeps the branch there: a commondir naming a repository inside the
	// tree would have its commits go aside with it.
	const repository = dirname(dirname(own));
	const common = readPlain(join(own, "commondir"))?.trim();
	if (
		common === undefined ||
		real(resolve(own, common)) !== real(repository) ||
		within(repository, path) ||
		!standsAsFolder(join(repository, "objects"))
	) {
		return "unknown";
	}
	const back = readPlain(join(own, "gitdir"))?.trim();
	return back !== undefined &&
		real(resolve(own, back)) === real(join(path, ".git"))
		? "entry"
		: "unknown";
}

/** What reclaim says of every tree it sets aside, said here too. */
const RUN_NO_GIT =
	"Run no git in it, nor in any repository inside it: a command in the sandbox may have written the settings and hooks git would run";

/**
 * Where a set-aside tree's commits are, by what its `.git` was, with a
 * snapshot's entry apart, since it kept no branch.
 */
const PARTED: Record<GitShape | "snapshot", string> = {
	entry:
		"Its .git was renamed so it no longer names git's entry for it. Its branch stays where it was, but that entry, with its index and HEAD, goes when the clone that cut it next cuts the name, or at `git worktree prune` there.",
	snapshot:
		"Its .git was renamed so it no longer names git's entry for it. It was a snapshot, on no branch, so anything committed in it is reachable only from that entry's HEAD, which goes when the clone that cut it next cuts the name, or at `git worktree prune` there: give such a commit a branch from that clone before then.",
	repository:
		"Its .git, a repository of its own rather than a worktree's, or a link to one, was renamed, and whatever was committed in it is there alone, on no branch of the checkout that cut it.",
	unknown:
		"Its .git was renamed. Where it led wasn't read, so whatever was committed in it may be there alone, on no branch of the checkout that cut it.",
	none: "It held no .git, so nothing was renamed. Git's entry for it, with its branch or a snapshot's commit, stays in the checkout that cut it until `git worktree prune` there: give such a commit a branch from that checkout before then.",
};

/** Whether anything stands at `path`, a link to nothing included. */
function standsAt(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		// Only a name that isn't there holds nothing; one that can't be
		// looked at is read as something whose commits can't be placed.
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

/**
 * Whether a folder stands at `path`, a link to one included, as the
 * guard reads a repository's objects.
 */
function standsAsFolder(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		// Nothing there, or nothing that may be looked at.
		return false;
	}
}

/** Whether a folder stands at `path`, without following a link there. */
function isFolder(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		// Nothing there, or nothing that may be looked at.
		return false;
	}
}

/**
 * Give back a tree git won't run in by setting it aside whole, where
 * reclaim sets the trees git can't read: what it holds can't be read,
 * so every file is kept. Only our share goes while another session
 * holds it too, as a release's does, and a tree whose git entry is
 * locked by hand stays, as reclaim leaves one; the lock is judged only
 * when it would move, so a session sharing such a tree can still go.
 */
async function setUnreadAside(
	broker: TreeBroker,
	found: HeldTree,
	refused: string,
): Promise<Answer> {
	const where = displayPath(found.path);
	// Said in each answer, so a move for one refusal can't pass for another.
	const because = `Git's refusal: ${refused}`;
	// Read before the move, so the answer says where its commits are: a
	// repository of its own keeps them alone, not on the clone's branch.
	const read = gitShape(found.path);
	const shape =
		// By what the record says it was cut as, never by its commit's
		// form: a snapshot cut at a short id or a ref's name is as
		// detached as one cut at a full id.
		read === "entry" &&
		found.identity.shareable &&
		found.identity.key.startsWith("snapshot-")
			? "snapshot"
			: read;
	let aside: string | undefined;
	const into = strandedDir(treeDir());
	let others = 0;
	let locked = false;
	let tried = false;
	try {
		const outcome = await broker.setAside(found, (path) => {
			if (handLocked(path)) {
				locked = true;
				throw new Error(HAND_LOCKED);
			}
			tried = true;
			aside = setAsideWhole(path, into);
		});
		if (outcome.kind === "released") others = outcome.kept ?? 0;
	} catch (error) {
		if (locked) {
			return refuse(
				`${GLYPH.refused} ${where} is still held, and still there: ${HAND_LOCKED}.`,
			);
		}
		const why = plainWords(
			error instanceof Error ? error.message : String(error),
		);
		if (error instanceof StuckAside) {
			// The tree has left the path its hold and record named, so
			// both went: kept, they would name whatever stands there now.
			// Where it is is said whole, apart from the reasons shortened.
			return refuse(
				`${GLYPH.refused} Git won't run in ${where}, so it was set aside whole, but it is only half done: it is at ${displayPath(error.aside)}, every file in it, ${plainWords(error.reasons)}. It is no longer held here, and whatever stands at ${where} now is not it: deal with it where it stands by hand. ${RUN_NO_GIT}. ${because}.`,
			);
		}
		if (error instanceof RecordWent) {
			return refuse(
				`${GLYPH.refused} Git won't run in ${where}, but ${why}. Nothing moved.`,
			);
		}
		if (!tried) {
			return refuse(
				`${GLYPH.refused} Git won't run in ${where}, and who else holds it couldn't be read or written: ${why}. Nothing moved, and it is still held.`,
			);
		}
		if (aside !== undefined) {
			return refuse(
				`${GLYPH.refused} ${found.identity.key} was set aside whole at ${displayPath(aside)}, every file in it kept, but its record couldn't be forgotten: ${why}. It is no longer held here. ${RUN_NO_GIT}. ${because}.`,
			);
		}
		const still = existsSync(found.path)
			? "It is still there and still held."
			: "Nothing is there now, so nothing is left to hold.";
		return refuse(
			`${GLYPH.refused} Git won't run in ${where}, so it was to be set aside whole, but that was refused: ${why}. ${still} ${because}.`,
		);
	}
	if (aside === undefined) {
		const sessions =
			others === 1 ? "session still holds" : "sessions still hold";
		return say(
			`${GLYPH.named} Released ${found.identity.key}, though ${others} other ${sessions} it, so it stays at ${where} for them. Git won't run in it, so the last to release it sets it aside whole.`,
			{ ok: true, released: found.identity.key, kept: others },
		);
	}
	return say(
		`${GLYPH.named} Released ${found.identity.key} by setting it aside whole at ${displayPath(aside)}: git won't run in it outside the sandbox, so what it holds couldn't be read, and every file in it was kept. ${PARTED[shape]} ${RUN_NO_GIT}. ${because}.`,
		{ ok: true, released: found.identity.key, aside },
	);
}
