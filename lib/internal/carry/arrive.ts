/**
 * Arriving with a session another machine carried here: its done file
 * waited for, each of its trees put in place, and its file placed where
 * `pi --session <id>` finds it.
 *
 * mycelium starts `pi-carry arrive ... && exec pi --session <id>` on the
 * machine a quest goes to, so nothing may start half arrived. The share
 * may land after the start, so the done file, and every file it names,
 * is waited for, saying so every half minute. A tree is cloned from its
 * origin where it isn't, or fetched where it is, given what the bundle
 * left out from the remotes it names, then the bundle's commits, checked
 * out on its branch at its head, and given its changes. A folder already
 * there with another origin or work of its own is refused, never written
 * over; and so is a branch here holding commits the carried one lacks.
 * A tree that already stands as carried, as one arrived before does, is
 * left as it is, so arriving again does no harm.
 */

import { existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "../../core/exec/index.ts";
import { placeTakenOver } from "../quest/carried.ts";
import {
	doneFileOf,
	type HandedTree,
	type Handover,
	readHandover,
	underHome,
} from "./handover.ts";

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
	/** pi's session store. */
	readonly sessions: string;
	readonly clock: Clock;
	readonly say: (line: ArrivalLine) => void;
}

/** Arrives with the session; answers whether everything came and stands. */
export async function arrive(arriving: Arriving): Promise<boolean> {
	const { from, home, say } = arriving;
	const handover = await waitForHandover(arriving);
	if (handover === undefined) return false;
	let whole = true;
	for (const tree of handover.trees) {
		const line = await arriveTree(arriving.exec, tree, from, home);
		say(line);
		if (line.did === "refused") whole = false;
	}
	const cwd = underHome(handover.cwd, home);
	if (handover.sessionFile === undefined) {
		say({ kind: "sessions", sessions: [] });
		return whole;
	}
	const placed = placeTakenOver(
		handover.session,
		join(from, handover.sessionFile),
		cwd,
		arriving.sessions,
	);
	if (placed === undefined) {
		say({
			kind: "failed",
			why: `${handover.sessionFile} doesn't hold session ${handover.session}, so it wasn't placed.`,
		});
		say({ kind: "sessions", sessions: [] });
		return false;
	}
	say({ kind: "sessions", sessions: [{ id: handover.session, cwd }] });
	return whole;
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

/** git run in one tree, three ways of hearing it. */
interface TreeGit {
	run(...args: string[]): Promise<{ code: number; stderr: string }>;
	ok(...args: string[]): Promise<boolean>;
	said(...args: string[]): Promise<string | undefined>;
}

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
	const why = await settleTree(git, tree, from);
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
