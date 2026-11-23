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

import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Exec } from "../../core/exec/index.ts";
import type { FenceKind } from "../../mesh/presence.ts";
import { placeTakenOver } from "../quest/reopening/carried.ts";
import { ZIPPED } from "./carry-away.ts";
import {
	doneFileOf,
	type HandedTree,
	type Handover,
	readHandover,
	underHome,
} from "./handover.ts";
import type { CarriedNote } from "./notes.ts";
import { holdToOrigin, takeView, type ViewGit } from "./origin-view.ts";
import { standSparse } from "./sparse.ts";
import { twinOf } from "./twin.ts";

/** How long a done file is waited for: the share may land late. */
export const ARRIVAL_WAIT_MS = 10 * 60_000;

/** How often waiting says it still waits. */
export const WAITING_SAID_MS = 30_000;

/** How often the handover folder is looked at while waiting. */
const LOOK_MS = 1000;

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

/** What arriving needs. */
export interface Arriving {
	readonly exec: Exec;
	/** The handover folder the carrying machine wrote: `handover/<machine>/`. */
	readonly from: string;
	/** The session (or quest) whose done file this is. */
	readonly session: string;
	/** This machine's home, under which paths within home are made whole. */
	readonly home: string;
	/** The quest's scratch folder here, which the handover folder lies in. */
	readonly scratch: string;
	/** pi's session store. */
	readonly sessions: string;
	readonly clock: Clock;
	readonly say: (line: ArrivalLine) => void;
	/** Adds the quest's carried facts that this machine lacks, answering how many. */
	readonly takeNotes: (
		quest: string,
		notes: readonly CarriedNote[],
	) => Promise<number>;
}

/** Arrives with the session; answers whether everything came and stands. */
export async function arrive(arriving: Arriving): Promise<boolean> {
	const { from, home, say } = arriving;
	const handover = await waitForHandover(arriving);
	if (handover === undefined) return false;
	const brought: HandedTree[] = [];
	for (const tree of handover.trees) {
		const line = await arriveTree(arriving.exec, tree, from, home);
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
	mkdirSync(cwd, { recursive: true });
	let placed: string | undefined;
	try {
		placed = await placeSession(
			handover.session,
			join(from, handover.sessionFile),
			cwd,
			arriving,
		);
	} catch (error) {
		say({
			kind: "failed",
			why: `${handover.sessionFile} couldn't be placed: ${error instanceof Error ? error.message : String(error)}`,
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
 * Places the session `id` carried at `file` for `cwd`, as
 * `placeTakenOver` does, answering where. A file carried gzipped, as
 * one larger than the share takes is, is unzipped first into the
 * scratch's tmp/, which is never shared, under its own name, and that
 * copy is removed once placed.
 */
async function placeSession(
	id: string,
	file: string,
	cwd: string,
	arriving: Arriving,
): Promise<string | undefined> {
	if (!file.endsWith(ZIPPED)) {
		return placeTakenOver(id, file, cwd, arriving.sessions);
	}
	const tmp = join(arriving.scratch, "tmp");
	mkdirSync(tmp, { recursive: true });
	const unzipping = mkdtempSync(join(tmp, "arriving-"));
	try {
		const plain = join(unzipping, basename(file).slice(0, -ZIPPED.length));
		await pipeline(
			createReadStream(file),
			createGunzip(),
			createWriteStream(plain),
		);
		return placeTakenOver(id, plain, cwd, arriving.sessions);
	} finally {
		rmSync(unzipping, { recursive: true, force: true });
	}
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
			why: `The quest's ${handover.notes.length} notes weren't taken up: ${error instanceof Error ? error.message : String(error)}`,
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
	| { readonly kind: "cloned" | "fetched" | "already" }
	| { readonly kind: "refused"; readonly why: string };

/** One tree put in place here, or refused with why. */
async function arriveTree(
	exec: Exec,
	tree: HandedTree,
	from: string,
	home: string,
): Promise<Extract<ArrivalLine, { kind: "tree" }>> {
	const path = underHome(tree.path, home);
	const git = treeGit(exec, path);
	const line = { kind: "tree" as const, path, branch: tree.branch };
	const readied = await readyTree(exec, git, tree, from, path);
	if (readied.kind === "refused") {
		return { ...line, did: "refused", why: readied.why };
	}
	if (readied.kind === "already") return { ...line, did: "fetched" };
	// Only a tree cloned here takes the sparse checkout it left in; one
	// already here keeps its own.
	const unsparse =
		readied.kind === "cloned" && tree.sparse !== undefined
			? await standSparse(git.run, tree.sparse)
			: undefined;
	const why = unsparse ?? (await settleTree(git, tree, from));
	if (why === undefined) return { ...line, did: readied.kind };
	// A clone made here holds nothing of anyone's, so arriving again starts afresh.
	if (readied.kind === "cloned") rmSync(path, { recursive: true, force: true });
	return { ...line, did: "refused", why };
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
): Promise<Readied> {
	const no = (why: string): Readied => ({ kind: "refused", why });
	if (!existsSync(path)) {
		const twin = await twinOf(exec, path, tree.origin);
		if (twin !== undefined) return await cloneTwin(exec, twin, tree, path);
		const cloned = await exec("git", [
			"clone",
			"-q",
			"--no-checkout",
			"--",
			tree.origin,
			path,
		]);
		return cloned.code === 0
			? { kind: "cloned" }
			: no(`git couldn't clone ${tree.origin}: ${cloned.stderr.trim()}`);
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
	return (await git.ok("fetch", "-q", "origin"))
		? { kind: "fetched" }
		: no("git couldn't fetch its origin.");
}

/**
 * The tree cloned from its twin here, never writing to it, then pointed
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
	path: string,
): Promise<Readied> {
	const cloned = await exec("git", [
		"clone",
		"-q",
		"--no-checkout",
		"--",
		twin,
		path,
	]);
	if (cloned.code !== 0) {
		return {
			kind: "refused",
			why: `git couldn't clone ${twin}: ${cloned.stderr.trim()}`,
		};
	}
	const why = await asOrigin(treeGit(exec, path), twin, tree.origin);
	if (why === undefined) return { kind: "cloned" };
	rmSync(path, { recursive: true, force: true });
	return { kind: "refused", why };
}

/**
 * A tree cloned from `twin` made to hold only what `origin` holds: its
 * origin branches the twin's view of origin, held to origin's own list,
 * no branch of its own, and `origin` its remote. A twin with no view of
 * origin, such as a bare clone, lends its own branches as the view, since
 * origin's list then keeps only those that match. Answers why not, or
 * nothing.
 */
async function asOrigin(
	git: TreeGit,
	twin: string,
	origin: string,
): Promise<string | undefined> {
	// The one branch a clone makes, the twin's own, goes; checking out
	// the carried branch later makes it again from the carried head.
	const own = await git.said("symbolic-ref", "-q", "HEAD");
	if (
		own !== undefined &&
		(await git.said("rev-parse", "-q", "--verify", own))
	) {
		const dropped = await git.run("update-ref", "-d", own);
		if (dropped.code !== 0) {
			return `git couldn't drop the twin's branch: ${dropped.stderr.trim()}`;
		}
	}
	// The clone's pointer to the twin's own branch, which goes with it.
	await git.run("symbolic-ref", "-q", "-d", "refs/remotes/origin/HEAD");
	const why = await takeView(git, twin);
	if (why !== undefined) return why;
	const pointed = await git.run("remote", "set-url", "origin", origin);
	if (pointed.code !== 0) {
		return `git couldn't point it at ${origin}: ${pointed.stderr.trim()}`;
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
): Promise<string | undefined> {
	const why = await takeCommits(git, tree, from);
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

function treeGit(exec: Exec, path: string): TreeGit {
	const run = (...args: string[]) => exec("git", ["-C", path, ...args]);
	return {
		run,
		ok: async (...args) => (await run(...args)).code === 0,
		said: async (...args) => {
			const result = await run(...args);
			return result.code === 0 ? result.stdout.trim() : undefined;
		},
		fed: async (lines, ...args) => {
			// Exec gives no stdin, so the lines go through a file sh reads in.
			const folder = mkdtempSync(join(tmpdir(), "carry-git-"));
			const file = join(folder, "in");
			try {
				writeFileSync(file, `${lines.join("\n")}\n`);
				return await exec("sh", [
					"-c",
					'f=$1 p=$2; shift 2; exec git -C "$p" "$@" < "$f"',
					"sh",
					file,
					path,
					...args,
				]);
			} finally {
				rmSync(folder, { recursive: true, force: true });
			}
		},
	};
}

/**
 * Brings the commits the tree needs: what the bundle left out, from the
 * remote branch each was on, then the bundle's own. Answers why not, or
 * nothing once its head is here.
 */
async function takeCommits(
	git: TreeGit,
	tree: HandedTree,
	from: string,
): Promise<string | undefined> {
	const has = (commit: string) =>
		git.ok("cat-file", "-e", `${commit}^{commit}`);
	for (const need of tree.needs) {
		if (await has(need.commit)) continue;
		const [remote, ...branch] = (need.on ?? "").split("/");
		if (
			remote &&
			branch.length > 0 &&
			(await git.ok("remote", "get-url", remote))
		) {
			await git.run("fetch", "-q", remote, branch.join("/"));
		}
		if (!(await has(need.commit))) {
			return `It needs ${need.commit}${need.on ? ` from ${need.on}` : ""}, which no remote here gave.`;
		}
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
