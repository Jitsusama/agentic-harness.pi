/**
 * Arriving with a session another machine carried here: its done file
 * waited for, each of its trees put in place, and its file placed where
 * `pi --session <id>` finds it.
 *
 * mycelium starts `pi-carry arrive ... && exec pi --session <id>` on the
 * machine a quest goes to, so nothing may start half arrived. The share
 * may land after the start, so the done file, and every file it names,
 * is waited for, saying so every half minute. A tree is cloned from its
 * origin where it isn't, borrowing the objects of a repository beside it
 * with the same origin ([`twin.ts`](twin.ts)), or fetched where it is,
 * given what the bundle
 * left out from the remotes it names, then the bundle's commits, checked
 * out on its branch at its head, and given its changes. A folder already
 * there with another origin or work of its own is refused, never written
 * over; and so is a branch here holding commits the carried one lacks.
 * A tree that already stands as carried, as one arrived before does, is
 * left as it is, so arriving again does no harm.
 *
 * The session is placed for its own folder only where a tree it brought
 * holds that folder, and otherwise for its quest's scratch, so it never
 * starts in a folder of the person's that no tree brought; `pi-carry
 * where` says which, for mycelium's shell to enter before pi starts.
 */

import { existsSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Exec, ExecResult } from "../../core/exec/index.ts";
import type { FenceKind } from "../../mesh/presence.ts";
import { within } from "../sandbox/tree-git.ts";
import { cutTreeDir } from "../work-records.ts";
import { placeRefused } from "./arrival-place.ts";
import { andLeft, claimed, letGoOf } from "./clone-aside.ts";
import { type Cut, cutFrom, holderOf, uncut } from "./cut.ts";
import {
	doneFileOf,
	flagIn,
	type HandedTree,
	type Handover,
	readHandover,
	underHome,
} from "./handover.ts";
import { messageOf } from "./message.ts";
import type { CarriedNote } from "./notes.ts";
import {
	BOUNDED,
	gitIn,
	type Held,
	holdToOrigin,
	saidOf,
	takeView,
	timed,
	type ViewGit,
} from "./origin-view.ts";
import { isReadForm, type Placing, placeSession } from "./place-session.ts";
import { standSparse } from "./sparse.ts";
import { cloningAt, guardedCheckoutOf, twinOf } from "./twin.ts";

/** How long a done file is waited for: the share may land late. */
export const ARRIVAL_WAIT_MS = 10 * 60_000;

/** How often waiting says it still waits. */
export const WAITING_SAID_MS = 30_000;

/** How often the handover folder is looked at while waiting. */
const LOOK_MS = 1000;

/**
 * How long a tree has to clone or fetch its origin and fetch the commits
 * it needs, all told, over any transport. A tree far
 * behind a big trunk on a slow link takes long, so this only stops a
 * fetch that would never end; `BOUNDED` stops an http link that stalls
 * well before.
 */
const CATCHING_UP = 3600;

/** Time, as arriving reads and spends it; a test gives a fake one. */
export interface Clock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

/** One line arriving says, as `pi-carry arrive` prints it. */
export type ArrivalLine =
	| {
			readonly kind: "waiting";
			readonly file: string;
			readonly waited: number;
			readonly lacking: readonly string[];
	  }
	| {
			readonly kind: "tree";
			readonly path: string;
			readonly branch: string;
			readonly did: "cloned" | "fetched" | "refused";
			readonly why?: string;
			/**
			 * For a tree that arrived, why it claims less of origin than
			 * origin holds, so a carry onward may bundle more.
			 */
			readonly unsure?: string;
	  }
	| { readonly kind: "failed"; readonly why: string }
	| {
			readonly kind: "sessions";
			readonly sessions: readonly { id: string; cwd: string }[];
			/**
			 * The fence the session ran under, for the node to start it under
			 * again; absent when an older harness carried it.
			 */
			readonly fence?: FenceKind;
	  };

/** What arriving needs; its scratch, sessions and unzip bound place the session. */
export interface Arriving extends Placing {
	readonly exec: Exec;
	/** The handover folder the carrying machine wrote: `handover/<machine>/`. */
	readonly from: string;
	/** The session (or quest) whose done file this is. */
	readonly session: string;
	/** This machine's home, under which paths within home are made whole. */
	readonly home: string;
	readonly clock: Clock;
	readonly say: (line: ArrivalLine) => void;
	/** Adds the quest's carried facts that this machine lacks, answering how many. */
	readonly takeNotes: (
		quest: string,
		notes: readonly CarriedNote[],
	) => Promise<number>;
	/** Where the work tool cuts trees; its own folder unless a test names one. */
	readonly trees?: string;
}

/** Arrives with the session; answers whether everything came and stands. */
export async function arrive(arriving: Arriving): Promise<boolean> {
	const { from, home, say } = arriving;
	const handover = await waitForHandover(arriving);
	if (handover === undefined) return false;
	const trees = arriving.trees ?? cutTreeDir();
	const brought: HandedTree[] = [];
	for (const tree of handover.trees) {
		const line = await arriveTree(arriving.exec, tree, from, {
			home,
			trees,
			left: secondsLeft(arriving.clock, CATCHING_UP),
		});
		say(line);
		if (line.did !== "refused") brought.push(tree);
	}
	const noted = await notesTaken(arriving, handover);
	const whole = brought.length === handover.trees.length && noted;
	if (handover.sessionFile === undefined) {
		say({ kind: "sessions", sessions: [] });
		return whole;
	}
	const cwd = arrivalFolder(
		{ ...handover, trees: brought },
		home,
		arriving.scratch,
	);
	if (!isReadForm(handover.sessionFile)) {
		say({
			kind: "failed",
			why: `${handover.sessionFile} is in a form this machine's harness can't read, so it wasn't placed: this harness is likely older than the carrying machine's, and arriving again once it is updated places it.`,
		});
		say({ kind: "sessions", sessions: [] });
		return false;
	}
	mkdirSync(cwd, { recursive: true });
	let placed: string | undefined;
	try {
		// pi finds a session in the folder it derives from where it runs, as
		// its real path, though the node's shell enters `cwd` through any
		// link in it, as a home under /home linked to /var/home is.
		placed = await placeSession(
			handover.session,
			join(from, handover.sessionFile),
			realpathSync(cwd),
			arriving,
		);
	} catch (error) {
		say({
			kind: "failed",
			why: `${handover.sessionFile} couldn't be placed: ${messageOf(error)}`,
		});
		say({ kind: "sessions", sessions: [] });
		return false;
	}
	if (placed === undefined) {
		say({
			kind: "failed",
			why: `${handover.sessionFile} doesn't hold session ${handover.session}, so it wasn't placed.`,
		});
		say({ kind: "sessions", sessions: [] });
		return false;
	}
	// The node starts pi itself, so it, not this environment, sets the
	// fence the session arrives under (KP0L6A [35567865]).
	say({
		kind: "sessions",
		sessions: [{ id: handover.session, cwd }],
		...(handover.fence === undefined ? {} : { fence: handover.fence }),
	});
	return whole;
}

/**
 * Takes up the done file's notes, answering whether that went; a store
 * that can't take them is said, and arriving again tries once more.
 */
async function notesTaken(
	arriving: Arriving,
	handover: Handover,
): Promise<boolean> {
	if (handover.notes === undefined || handover.notes.length === 0) return true;
	try {
		await arriving.takeNotes(handover.quest, handover.notes);
		return true;
	} catch (error) {
		arriving.say({
			kind: "failed",
			why: `The quest's ${handover.notes.length} notes weren't taken up: ${messageOf(error)}`,
		});
		return false;
	}
}

/**
 * The folder a carried session arrives in: its own, where it lies
 * within a tree it brought; or its quest's scratch, so it never starts
 * in a folder of the person's own that no tree brought, such as their
 * checkout, whose rules and state belong to nothing carried. Only trees
 * travel, so a folder within one the tree didn't hold may yet be made.
 * `handover`'s trees are those that came: a refused one brought nothing.
 */
export function arrivalFolder(
	handover: Handover,
	home: string,
	scratch: string,
): string {
	const cwd = underHome(handover.cwd, home);
	const brought = handover.trees.some((tree) =>
		liesWithin(cwd, underHome(tree.path, home)),
	);
	return brought ? cwd : scratch;
}

/**
 * The folder the session `session`, carried into the handover folder
 * `from`, arrived in once {@link arrive} went through whole, so every
 * tree its done file names came; or nothing when no done file there
 * names a session to arrive.
 */
export function arrivedIn(
	from: string,
	session: string,
	home: string,
	scratch: string,
): string | undefined {
	const handover = readHandover(doneFileOf(from, session));
	if (handover?.sessionFile === undefined) return undefined;
	return arrivalFolder(handover, home, scratch);
}

/** Whether `path` is `folder` or lies beneath it. */
function liesWithin(path: string, folder: string): boolean {
	const inside = relative(folder, path);
	return !(
		inside === ".." ||
		inside.startsWith(`..${sep}`) ||
		isAbsolute(inside)
	);
}

/**
 * The done file, once it and every file it names are here, or nothing
 * once {@link ARRIVAL_WAIT_MS} has passed without them.
 */
async function waitForHandover(
	arriving: Arriving,
): Promise<Handover | undefined> {
	const { from, session, clock, say } = arriving;
	const file = doneFileOf(from, session);
	const start = clock.now();
	let saidAt: number | undefined;
	for (;;) {
		const handover = readHandover(file);
		const lacking =
			handover === undefined
				? [file]
				: namedFiles(handover, from).filter((one) => !existsSync(one));
		if (handover !== undefined && lacking.length === 0) return handover;
		const waited = clock.now() - start;
		if (waited >= ARRIVAL_WAIT_MS) {
			say({
				kind: "failed",
				why: `Nothing whole came to ${file} in ${ARRIVAL_WAIT_MS / 60_000} minutes; still lacking ${lacking.join(", ")}.`,
			});
			return undefined;
		}
		if (saidAt === undefined || clock.now() - saidAt >= WAITING_SAID_MS) {
			saidAt = clock.now();
			say({
				kind: "waiting",
				file,
				waited: Math.round(waited / 1000),
				lacking,
			});
		}
		await clock.sleep(LOOK_MS);
	}
}

/** Every file beside the done file that it names. */
function namedFiles(handover: Handover, from: string): string[] {
	return [
		...(handover.sessionFile === undefined ? [] : [handover.sessionFile]),
		...handover.trees.flatMap((tree) => [
			...(tree.bundle === undefined ? [] : [tree.bundle]),
			...(tree.patch === undefined ? [] : [tree.patch]),
		]),
	].map((name) => join(from, name));
}

/** git run in one tree, three ways of hearing it, and its refs set. */
type TreeGit = ViewGit;

/** How a tree stood before it was given its commits. */
type Readied =
	| { readonly kind: "cloned"; readonly unsure?: string }
	/** Cut as a worktree of a checkout the fence guards. */
	| ({ readonly kind: "cut" } & Cut)
	| { readonly kind: "fetched" | "already" }
	| { readonly kind: "refused"; readonly why: string };

/** Where a tree arrives, and the seconds it has left to reach origin in. */
interface Here {
	readonly home: string;
	readonly trees: string;
	readonly left: () => number;
}

/** The whole seconds left of `seconds` from now, as `clock` reads it. */
function secondsLeft(clock: Clock, seconds: number): () => number {
	const ends = clock.now() + seconds * 1000;
	return () => Math.ceil((ends - clock.now()) / 1000);
}

/** Why a call to origin isn't made: its tree's time ran out. */
const OUT_OF_TIME = `the ${CATCHING_UP} seconds its tree had to reach origin all told ran out`;

/** One tree put in place here, or refused with why. */
async function arriveTree(
	exec: Exec,
	tree: HandedTree,
	from: string,
	here: Here,
): Promise<Extract<ArrivalLine, { kind: "tree" }>> {
	const path = underHome(tree.path, here.home);
	const git = gitIn(exec, path);
	const line = { kind: "tree" as const, path, branch: tree.branch };
	const flag = flagIn(tree);
	if (flag !== undefined) {
		return {
			...line,
			did: "refused",
			why: `Its done file names ${flag}, which git could read as an option, so it isn't given to git.`,
		};
	}
	const astray = placeRefused(path, here.home, here.trees);
	if (astray !== undefined) return { ...line, did: "refused", why: astray };
	const readied = await readyTree(exec, git, tree, from, path, here);
	if (readied.kind === "refused") {
		return { ...line, did: "refused", why: readied.why };
	}
	if (readied.kind === "already") return { ...line, did: "fetched" };
	const made = readied.kind === "cloned" || readied.kind === "cut";
	// Only a tree made here takes the sparse checkout it left in; one
	// already here keeps its own.
	const unsparse =
		made && tree.sparse !== undefined
			? await standSparse(git.run, tree.sparse)
			: undefined;
	const why = unsparse ?? (await settleTree(git, tree, from, here.left));
	if (why === undefined) {
		if (readied.kind === "cut") return { ...line, did: "cloned" };
		return readied.kind === "cloned" && readied.unsure !== undefined
			? { ...line, did: readied.kind, unsure: readied.unsure }
			: { ...line, did: readied.kind };
	}
	// A tree made here holds nothing of anyone's, so arriving again starts
	// afresh; one cut leaves the checkout's branch where it stood.
	if (readied.kind === "cut") {
		// Cut on no branch, it is on its own only once settling checked it
		// out there, so a branch another brought to the head stays.
		const on = await git.run("symbolic-ref", "-q", "HEAD");
		const settled =
			on.code === 0 && on.stdout.trim() === `refs/heads/${tree.branch}`
				? tree.head
				: undefined;
		const cutLeft = await uncut(exec, readied, path, tree.branch, settled);
		const left = [unreadHead(on, tree, readied.before), cutLeft].filter(
			(one) => one !== undefined,
		);
		if (left.length > 0) {
			return { ...line, did: "refused", why: andLeft(why, ...left) };
		}
	}
	// A clone left at the tree's own place is what the next arrival finds
	// there, whether it refuses it or takes it up: say to take it out first.
	const atPlace =
		readied.kind === "cloned"
			? letGoOf(
					path,
					"take it out before arriving again, since the next arrival finds it there",
				)
			: undefined;
	return { ...line, did: "refused", why: andLeft(why, atPlace) };
}

/**
 * Why the branch a cut tree settled may be left at the carried head,
 * where git couldn't say which branch the tree was on, with where it
 * stood `before` the cut, or that it wasn't there, so it can be put
 * back by hand; nothing where git said, or the tree stood on no branch,
 * which `-q` answers with 1 alone. spawnExec answers for a git a
 * signal stopped with 137, saying so (#2119), never 1 alone, so one
 * reads as unsaid, not as on no branch.
 */
function unreadHead(
	on: ExecResult,
	tree: HandedTree,
	before: string | undefined,
): string | undefined {
	if (on.code === 0 || (on.code === 1 && on.stderr.trim() === "")) {
		return undefined;
	}
	const said = on.stderr.trim() || `git exited ${on.code}`;
	const stood =
		before === undefined
			? "though there was no such branch before"
			: `where it stood at ${before} before`;
	return `its branch ${tree.branch} may be left at ${tree.head}, ${stood}, since git couldn't say which branch the tree was on: ${said}`;
}

/**
 * The tree cloned where nothing is, or fetched where it already stands
 * with the same origin and nothing of its own changed; or why not.
 */
async function readyTree(
	exec: Exec,
	git: TreeGit,
	tree: HandedTree,
	from: string,
	path: string,
	here: Here,
): Promise<Readied> {
	const no = (why: string): Readied => ({ kind: "refused", why });
	if (!existsSync(path)) {
		// The tree isn't there yet: within judges it where it would be made.
		if (within(path, here.trees)) {
			const checkout = await guardedCheckoutOf(
				exec,
				path,
				tree.origin,
				here.home,
			);
			if (checkout !== undefined) {
				const holder = await holderOf(exec, checkout, tree.branch);
				if (holder !== undefined) {
					return no(
						`Its branch ${tree.branch} is checked out at ${holder}, which shares its branches, so it isn't moved from under it.`,
					);
				}
				const cut = await cutFrom(exec, checkout, path, tree.branch);
				return "why" in cut ? no(cut.why) : { kind: "cut", ...cut };
			}
		}
		const twin = await twinOf(exec, path, tree.origin);
		if (twin === undefined && here.left() <= 0) {
			return no(`It wasn't cloned, since ${OUT_OF_TIME}.`);
		}
		// Into a name of its own beside the tree's, renamed into place once
		// whole and, from a twin, held to origin, so a failed or killed clone
		// is only ever what it made itself, beside the tree, never a
		// half-made tree at its place. The name is taken first, so what is
		// taken out after is a folder this arrival made, never one that
		// stood at that name already.
		const cloning = cloningAt(path, Date.now());
		const unclaimed = claimed(cloning);
		if (unclaimed !== undefined) return no(unclaimed);
		const cloned =
			twin === undefined
				? await cloneOrigin(exec, tree, cloning, here.left())
				: await cloneTwin(exec, twin, tree, cloning);
		if (cloned.kind === "refused") {
			return no(andLeft(cloned.why, letGoOf(cloning)));
		}
		if (existsSync(path)) {
			return no(
				andLeft(
					"Something arrived there while it was cloned.",
					letGoOf(cloning),
				),
			);
		}
		// Judged again, since a link above it may have moved while it cloned.
		const astray = placeRefused(path, here.home, here.trees);
		if (astray !== undefined) return no(andLeft(astray, letGoOf(cloning)));
		try {
			renameSync(cloning, path);
		} catch (error) {
			return no(
				andLeft(
					`Its clone couldn't be put in place: ${messageOf(error)}`,
					letGoOf(cloning),
				),
			);
		}
		// git's own words may name the clone's folder, now at the tree's place.
		return cloned.kind !== "cloned" || cloned.unsure === undefined
			? cloned
			: { ...cloned, unsure: cloned.unsure.replaceAll(cloning, () => path) };
	}
	const top = await git.said("rev-parse", "--show-toplevel");
	if (top === undefined || realpathSync(top) !== realpathSync(path)) {
		return no("Something is already there that isn't a git tree of its own.");
	}
	const origin = await git.said("config", "--get", "remote.origin.url");
	if (origin !== tree.origin) {
		return no(
			`The tree already there has another origin, ${origin ?? "none"}.`,
		);
	}
	if (await standsAsCarried(git, tree, from)) return { kind: "already" };
	if (
		(await git.said("status", "--porcelain", "--untracked-files=all")) !== ""
	) {
		return no(
			"The tree already there has changes of its own, which arriving would write over.",
		);
	}
	if (here.left() <= 0)
		return no(`It didn't fetch its origin, since ${OUT_OF_TIME}.`);
	const fetched = await git
		.within(here.left())
		.run(...BOUNDED, "fetch", "-q", "origin");
	return fetched.code === 0
		? { kind: "fetched" }
		: no(`git couldn't fetch its origin: ${saidOf(fetched)}`);
}

/** The tree's origin cloned at `cloning`, within the `left` seconds it has. */
async function cloneOrigin(
	exec: Exec,
	tree: HandedTree,
	cloning: string,
	left: number,
): Promise<Readied> {
	const cloned = await timed(left, () =>
		exec("git", [
			...BOUNDED,
			"clone",
			"-q",
			"--no-checkout",
			"--",
			tree.origin,
			cloning,
		]),
	);
	return cloned.code === 0
		? { kind: "cloned" }
		: {
				kind: "refused",
				why: `git couldn't clone ${tree.origin}: ${saidOf(cloned)}`,
			};
}

/**
 * The tree cloned from its twin here at `cloning`, never writing to it, then pointed
 * at its own origin, so the commits it needs come from there one branch
 * at a time.
 *
 * Not a clone of the origin with the twin as a reference: that still
 * asks the origin for every branch, and Delta refused one for World on
 * 23 November, as asking for 519,886 objects at once past its bound of
 * 200,000. A clone from the twin asks the network for nothing.
 *
 * A plain local clone, which hardlinks the twin's objects on one volume,
 * not `--shared`: a shared clone keeps needing the twin's objects, and
 * a gc in the twin after it deletes a branch leaves it broken. And its
 * branches are the twin's view of origin, not the twin's own branches,
 * which a clone would name as origin's: carrying it on would then leave
 * out commits only the twin holds, as though a remote had them.
 */
async function cloneTwin(
	exec: Exec,
	twin: string,
	tree: HandedTree,
	cloning: string,
): Promise<Readied> {
	const cloned = await exec("git", [
		"clone",
		"-q",
		"--no-checkout",
		"--",
		twin,
		cloning,
	]);
	if (cloned.code !== 0) {
		return {
			kind: "refused",
			why: `git couldn't clone ${twin}: ${cloned.stderr.trim()}`,
		};
	}
	const held = await asOrigin(gitIn(exec, cloning), twin, tree.origin);
	if (held.why === undefined) {
		return held.unsure === undefined
			? { kind: "cloned" }
			: { kind: "cloned", unsure: held.unsure };
	}
	return { kind: "refused", why: held.why };
}

/**
 * A tree cloned from `twin` made to hold only what `origin` holds: its
 * origin branches the twin's view of origin, held to origin's own list,
 * no branch of its own, and `origin` its remote. A twin with no view of
 * origin, such as a bare clone, lends its own branches as the view, since
 * origin's list then keeps only those that match. Answers why not, or
 * why it claims less of origin than origin holds, or nothing.
 */
async function asOrigin(
	git: TreeGit,
	twin: string,
	origin: string,
): Promise<Held> {
	// The one branch a clone makes, the twin's own, goes; checking out
	// the carried branch later makes it again from the carried head.
	const own = await git.said("symbolic-ref", "-q", "HEAD");
	if (
		own !== undefined &&
		(await git.said("rev-parse", "-q", "--verify", own))
	) {
		const dropped = await git.run("update-ref", "-d", own);
		if (dropped.code !== 0) {
			return {
				why: `git couldn't drop the twin's branch: ${dropped.stderr.trim()}`,
			};
		}
	}
	// The clone's pointer to the twin's own branch, which goes with it.
	await git.run("symbolic-ref", "-q", "-d", "refs/remotes/origin/HEAD");
	const why = await takeView(git, twin);
	if (why !== undefined) return { why };
	const pointed = await git.run("remote", "set-url", "origin", origin);
	if (pointed.code !== 0) {
		return {
			why: `git couldn't point it at ${origin}: ${pointed.stderr.trim()}`,
		};
	}
	return holdToOrigin(git);
}

/**
 * Gives the tree its commits, its branch at its head and its changes;
 * answers why not, or nothing once it stands as carried.
 */
async function settleTree(
	git: TreeGit,
	tree: HandedTree,
	from: string,
	left: () => number,
): Promise<string | undefined> {
	const why = await takeCommits(git, tree, from, left);
	if (why !== undefined) return why;
	const local = await git.said(
		"rev-parse",
		"--verify",
		"-q",
		`refs/heads/${tree.branch}`,
	);
	if (
		local !== undefined &&
		!(await git.ok("merge-base", "--is-ancestor", local, tree.head))
	) {
		return `Its branch ${tree.branch} here has commits the carried one lacks.`;
	}
	const checkedOut = await git.run(
		"checkout",
		"-q",
		"-B",
		tree.branch,
		tree.head,
	);
	if (checkedOut.code !== 0) {
		return `git couldn't check out ${tree.branch}: ${checkedOut.stderr.trim()}`;
	}
	if (tree.patch === undefined) return undefined;
	const applied = await git.run("apply", "--binary", join(from, tree.patch));
	return applied.code === 0
		? undefined
		: `Its changes didn't apply: ${applied.stderr.trim()}`;
}

/**
 * Brings the commits the tree needs: what the bundle left out, from the
 * remote branch each was on, within the `left` seconds its tree has,
 * then the bundle's own. Answers why not, or nothing once its head is
 * here.
 */
async function takeCommits(
	git: TreeGit,
	tree: HandedTree,
	from: string,
	left: () => number,
): Promise<string | undefined> {
	const has = (commit: string) =>
		git.ok("cat-file", "-e", `${commit}^{commit}`);
	for (const need of tree.needs) {
		if (await has(need.commit)) continue;
		const needs = `It needs ${need.commit}${need.on ? ` from ${need.on}` : ""}`;
		const [remote, ...branch] = (need.on ?? "").split("/");
		if (
			!remote ||
			branch.length === 0 ||
			!(await git.ok("remote", "get-url", "--", remote))
		) {
			return `${needs}, which no remote here gave.`;
		}
		if (left() <= 0) {
			return `${needs}, but ${OUT_OF_TIME} before it was asked for.`;
		}
		// Past `--`, so neither reads as a flag, though arrival already
		// refuses a tree naming one that would.
		const fetched = await git
			.within(left())
			.run(...BOUNDED, "fetch", "-q", "--", remote, branch.join("/"));
		if (await has(need.commit)) continue;
		return fetched.code === 0
			? `${needs}, which no remote here gave.`
			: `${needs}, but git couldn't fetch it: ${saidOf(fetched)}`;
	}
	if (tree.bundle !== undefined) {
		const fetched = await git.run(
			"fetch",
			"-q",
			join(from, tree.bundle),
			`refs/heads/${tree.branch}`,
		);
		if (fetched.code !== 0)
			return `git couldn't take its bundle: ${fetched.stderr.trim()}`;
	}
	return (await has(tree.head))
		? undefined
		: `Its head ${tree.head} didn't come.`;
}

/**
 * Whether the tree already stands as carried: on its branch at its head,
 * with its changes in place, as arriving left it before.
 */
async function standsAsCarried(
	git: TreeGit,
	tree: HandedTree,
	from: string,
): Promise<boolean> {
	if (
		(await git.said("symbolic-ref", "-q", "--short", "HEAD")) !== tree.branch
	) {
		return false;
	}
	if ((await git.said("rev-parse", "HEAD")) !== tree.head) return false;
	const changed =
		(await git.said("status", "--porcelain", "--untracked-files=all")) !== "";
	if (tree.patch === undefined) return !changed;
	return (
		changed &&
		git.ok("apply", "--binary", "--reverse", "--check", join(from, tree.patch))
	);
}
