/**
 * Where pi may run git outside the fence, and how.
 *
 * Git runs a repository's settings and hooks as their owner: a
 * `core.fsmonitor` in its config is a program git starts. pi runs git
 * outside the fence (the work tool, the review tools, the write
 * classifier), so a folder whose git a fenced command could shape is a
 * way out of it. The fence keeps each repository's settings, hooks and
 * `worktrees` read-only where `gitFolders` finds it, but a tree's `.git`
 * file, and any repository elsewhere, stays writable inside.
 *
 * So before pi runs git in a folder, this finds the git that folder
 * answers to. A tree's `.git` file is taken only when its own folder in
 * a repository's `worktrees` points back at it and names that
 * repository, which a fenced command can't arrange, and git is then
 * told that folder outright, so a `.git` file changed later counts for
 * nothing. The repository must also be one the fence guards for a tree
 * where the work tool cuts them, and for anything at all when this
 * session's own commands run fenced. A repository's git folder that
 * holds a `commondir` of its own is refused, since git would read its
 * settings from wherever that names, and every git that runs has
 * `core.fsmonitor` off.
 */

import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Exec, ExecResult } from "../core/exec/index.ts";
import { guardsGitFolder } from "./fence.ts";
import type { Disk } from "./fence-disk.ts";

/** A path as it really is, or as given when it can't be resolved. */
export function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Whether `path` is `folder` or lies inside it, as both really are. */
export function within(path: string, folder: string): boolean {
	const between = relative(real(folder), real(path));
	return (
		between === "" || !(between.startsWith("..") || between.startsWith("/"))
	);
}

/**
 * The folder a `.git` file names, read from `tree`, as it really is;
 * throws when `tree` has no `.git` file.
 */
export function namedGitFolder(tree: string): string | undefined {
	const named = /^gitdir: (.+)$/m.exec(
		readFileSync(join(tree, ".git"), "utf8"),
	)?.[1];
	return named ? real(resolve(tree, named.trim())) : undefined;
}

/**
 * The git folder of the repository `cwd` is a worktree of, or nothing
 * when it isn't one.
 *
 * The `.git` file naming it lies in the working folder, which commands
 * write, so it is taken only when the folder it names is a worktree's
 * own, in its repository's `worktrees`, and points back at this `.git`;
 * a command can make neither outside its work. A repository holding the
 * home folder is never given.
 */
export function worktreeRepository(
	cwd: string,
	home: string,
): string | undefined {
	try {
		const own = namedGitFolder(cwd);
		if (!own || basename(dirname(own)) !== "worktrees") return undefined;
		const repository = dirname(dirname(own));
		const back = readFileSync(join(own, "gitdir"), "utf8").trim();
		if (real(resolve(own, back)) !== real(join(cwd, ".git"))) return undefined;
		if (!statSync(join(repository, "objects")).isDirectory()) return undefined;
		return within(home, repository) ? undefined : repository;
	} catch {
		// No .git file here, or one naming no worktree of a repository.
		return undefined;
	}
}

/** A worktree's git: its own folder, and its repository's git folder. */
export interface TreeGit {
	readonly gitDir: string;
	readonly common: string;
}

/**
 * The git of the worktree at `tree`, when its `.git` file, its git
 * folder's way back and that folder's `commondir` all agree on one
 * repository outside the home folder; nothing otherwise.
 */
export function treeGit(tree: string, home: string): TreeGit | undefined {
	const common = worktreeRepository(tree, home);
	if (common === undefined) return undefined;
	try {
		const own = namedGitFolder(tree);
		if (!own) return undefined;
		const named = readFileSync(join(own, "commondir"), "utf8").trim();
		return real(resolve(own, named)) === real(common)
			? { gitDir: own, common }
			: undefined;
	} catch {
		// A git folder with no commondir is no worktree git cut.
		return undefined;
	}
}

/** What git must hold to, for the session asking. */
export interface GitRules {
	/** The home folder, as it really is. */
	readonly home: string;
	/** Whether this session's commands run fenced or sandboxed. */
	readonly fenced: boolean;
	/** Where the work tool cuts trees, each of which must be a worktree. */
	readonly trees: string;
	readonly disk?: Disk;
}

/** How git may run: with these arguments, or not at all, and why. */
export type GitRun =
	| { readonly args: readonly string[] }
	| { readonly refused: string };

/** The git `folder` answers to, as git would find it walking up. */
type FoundGit =
	| { readonly kind: "none" }
	| { readonly kind: "tree"; readonly top: string }
	| { readonly kind: "repository"; readonly top: string; readonly git: string }
	| { readonly kind: "link"; readonly top: string };

/** The first git above or at `folder`: a tree's `.git` file, a repository or a bare one. */
function foundGit(folder: string): FoundGit {
	let at = real(resolve(folder));
	for (;;) {
		const dotGit = join(at, ".git");
		const kind = kindOf(dotGit);
		if (kind === "link") return { kind: "link", top: at };
		if (kind === "file") return { kind: "tree", top: at };
		if (kind === "folder") return { kind: "repository", top: at, git: dotGit };
		if (
			kindOf(join(at, "HEAD")) === "file" &&
			kindOf(join(at, "objects")) === "folder"
		) {
			return { kind: "repository", top: at, git: at };
		}
		const up = dirname(at);
		if (up === at) return { kind: "none" };
		at = up;
	}
}

/** What is at `path`, not following a link. */
function kindOf(path: string): "file" | "folder" | "link" | undefined {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) return "link";
		return stat.isDirectory() ? "folder" : "file";
	} catch {
		// Nothing there.
		return undefined;
	}
}

/**
 * What every git pi runs outside the fence is given first: no
 * filesystem monitor, the one setting that starts a program on every
 * status, whatever the repository's own settings say.
 */
const OUTSIDE_SETTINGS = ["-c", "core.fsmonitor=false"] as const;

/** `args` as git runs them outside the fence. */
function outside(args: readonly string[]): GitRun {
	return { args: [...OUTSIDE_SETTINGS, ...args] };
}

/**
 * Why git won't run with `git` as a repository's git folder, when it
 * holds a `commondir`: git would read the settings of the folder that
 * names, which needn't be one the fence guards. Only a worktree's own
 * git folder has one.
 */
function redirected(top: string, git: string): GitRun | undefined {
	return kindOf(join(git, "commondir")) === undefined
		? undefined
		: {
				refused: `${top}'s git folder ${git} holds a commondir, which would have git read the settings of another folder, so git won't run there.`,
			};
}

/** What a fenced session is told to do instead of naming an unguarded repository. */
const CUT_ELSEWHERE =
	"Cut the tree from a checkout under ~/src, whose settings the fence keeps read-only (`work tree`).";

/**
 * How git may run `args` in `folder` for pi, outside the fence: as
 * asked, with a tree's own git folder and working folder named
 * outright, or not at all, saying why. A caller that names the git
 * folder itself has chosen it, so its arguments go as they are.
 */
export function gitRun(
	folder: string,
	args: readonly string[],
	rules: GitRules,
): GitRun {
	if (args.some((arg) => arg === "--git-dir" || arg.startsWith("--git-dir="))) {
		return outside(args);
	}
	const found = foundGit(folder);
	if (found.kind === "none") return outside(args);
	if (found.kind === "link") {
		return {
			refused: `${found.top}'s .git is a link, which pi won't follow outside the sandbox: git would run whatever settings it leads to.`,
		};
	}
	if (found.kind === "repository") {
		const elsewhere = redirected(found.top, found.git);
		if (elsewhere) return elsewhere;
		if (within(found.top, rules.trees)) {
			return {
				refused: `${found.top} lies where the work tool cuts trees but holds a repository of its own rather than a worktree, so git won't run there. Release it and cut it again.`,
			};
		}
		if (
			rules.fenced &&
			!guardsGitFolder(real(found.git), rules.home, rules.disk)
		) {
			return {
				refused: `${found.top} is a repository the sandbox doesn't keep read-only, so a sandboxed command could have set what git runs there, and pi runs git outside the sandbox. ${CUT_ELSEWHERE}`,
			};
		}
		return outside(args);
	}
	const tree = treeGit(found.top, rules.home);
	if (!tree) {
		return {
			refused: `${found.top}'s .git file names no worktree whose repository names it back, so git won't run there: a command may have pointed it at a git folder of its own. Release the tree and cut it again.`,
		};
	}
	// A tree where the work tool cuts them is held to this in every
	// session: any session's sandboxed commands can write its `.git` file,
	// and a repository's `worktrees` folder outside the fence's guard can
	// be laid out to agree with it.
	const elsewhere = redirected(found.top, tree.common);
	if (elsewhere) return elsewhere;
	const cut = within(found.top, rules.trees);
	if (
		(rules.fenced || cut) &&
		!guardsGitFolder(real(tree.common), rules.home, rules.disk)
	) {
		return {
			refused: `${found.top} is a worktree of ${tree.common}, which the sandbox doesn't keep read-only, so a sandboxed command could have set what git runs there, and pi runs git outside the sandbox. ${CUT_ELSEWHERE}`,
		};
	}
	return outside([
		`--git-dir=${tree.gitDir}`,
		`--work-tree=${found.top}`,
		...args,
	]);
}

/** The exit code a refused git answers with, as a shell's for a command it won't run. */
const GIT_REFUSED = 126;

/**
 * The folder git would run in for `args`, each leading `-C` taken in
 * turn from `cwd`, as git takes them.
 */
function gitFolder(cwd: string, args: readonly string[]): string {
	let folder = cwd;
	for (let at = 0; at < args.length && args[at]?.startsWith("-"); at++) {
		const arg = args[at] ?? "";
		if (arg === "-C") {
			folder = resolve(folder, args[at + 1] ?? "");
			at++;
		} else if (arg === "-c") {
			at++;
		}
	}
	return folder;
}

/**
 * `exec` with every git it runs held to `gitRun`'s answer, from `cwd`
 * or pi's own folder, under the rules `rules` gives at each call.
 * Any other program runs as it is.
 */
export function guardedExec(
	exec: Exec,
	rules: () => GitRules,
	cwd?: string,
): Exec {
	return (command, args) => {
		if (command !== "git") return exec(command, args);
		const run = gitRun(gitFolder(cwd ?? process.cwd(), args), args, rules());
		if ("refused" in run) {
			const refused: ExecResult = {
				code: GIT_REFUSED,
				stdout: "",
				stderr: run.refused,
			};
			return Promise.resolve(refused);
		}
		return exec(command, [...run.args]);
	};
}
