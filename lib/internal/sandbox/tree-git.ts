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
 *
 * A folder with no git at or above it gets git as asked, since git
 * finds nothing there to run, but only as it stands now: a command can
 * put a `.git` there while the git waits for the machine's queue. So
 * where the work tool cuts trees, which each must be a worktree, such
 * a folder is refused, and elsewhere the git carries the folder, so
 * the queue looks again when its turn comes (`queued-exec.ts`).
 *
 * Each of git's files is read only when plain and without waiting,
 * since a fenced command chooses what stands at a tree's `.git`, and a
 * fifo there would hold every git pi runs and reclaim's survey.
 */

import { lstatSync, realpathSync, statSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import type { Exec, ExecResult } from "../../core/exec/index.ts";
import { readPlain } from "../../core/work/plain-file.ts";
import { guardsGitFolder } from "../fence/fence.ts";
import type { Disk } from "../fence/fence-disk.ts";
import { landsAt } from "./leads-to.ts";

/** A path as it really is, or as given when it can't be resolved. */
export function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Whether `path` is `folder` or lies inside it, each where it leads past
 * its links, made yet or not, as a Mac's /tmp leads to /private/tmp
 * (leads-to.ts). Where either's links can't be followed it is judged as
 * far as they lead and spelled past that, as main judged a path realpath
 * couldn't resolve: callers ask this both to let a path in and to refuse
 * one, so no answer here would be the safe one for all of them, and the
 * fence's own checks refuse such a path outright (sandbox-files.ts).
 */
export function within(path: string, folder: string): boolean {
	const between = relative(landsAt(folder), landsAt(path));
	// A child named `..x` lies inside; only `..` and what climbs past it don't.
	return !(
		between === ".." ||
		between.startsWith(`..${sep}`) ||
		isAbsolute(between)
	);
}

/**
 * The folder a `.git` file names, read from `tree`, as it really is;
 * nothing when `tree` has no plain `.git` file naming one.
 */
export function namedGitFolder(tree: string): string | undefined {
	const named = /^gitdir: (.+)$/m.exec(
		readPlain(join(tree, ".git")) ?? "",
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
		const back = readPlain(join(own, "gitdir"))?.trim();
		if (!back) return undefined;
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
		const named = readPlain(join(own, "commondir"))?.trim();
		if (!named) return undefined;
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

/**
 * How git may run: with these arguments, or not at all, and why, with
 * the top of the repository it found, which a refusal still knows.
 */
export type GitRun =
	| {
			readonly args: readonly string[];
			/**
			 * The folder, as it really is, where no git stood at or above
			 * when this was answered, which must still hold none when git
			 * starts.
			 */
			readonly unrooted?: string;
	  }
	| { readonly refused: string; readonly top: string };

/** The git `folder` answers to, as git would find it walking up. */
type FoundGit =
	| { readonly kind: "none"; readonly at: string }
	| { readonly kind: "tree"; readonly top: string }
	| { readonly kind: "repository"; readonly top: string; readonly git: string }
	| { readonly kind: "link"; readonly top: string };

/**
 * The first git above or at `folder`: a tree's `.git` file, a repository or a bare one.
 * A bare one is taken whatever its `HEAD` is, with `objects` a link
 * too, since git follows a link to either, or with a `commondir` in
 * place of `objects`, since git then reads those from the folder it
 * names: a folder shaped so that git would take it is never read as
 * holding none.
 */
function foundGit(folder: string): FoundGit {
	const start = real(resolve(folder));
	let at = start;
	for (;;) {
		const dotGit = join(at, ".git");
		const kind = kindOf(dotGit);
		if (kind === "link") return { kind: "link", top: at };
		if (kind === "file") return { kind: "tree", top: at };
		if (kind === "folder") return { kind: "repository", top: at, git: dotGit };
		const objects = kindOf(join(at, "objects"));
		if (
			kindOf(join(at, "HEAD")) !== undefined &&
			(objects === "folder" ||
				objects === "link" ||
				kindOf(join(at, "commondir")) !== undefined)
		) {
			return { kind: "repository", top: at, git: at };
		}
		const up = dirname(at);
		if (up === at) return { kind: "none", at: start };
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
				top,
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
	// Every folder where the work tool cuts trees is a worktree, so one
	// whose git is none, or a repository above the trees, had its own
	// taken away.
	const start = real(resolve(folder));
	const above = found.kind === "repository" && !within(found.top, rules.trees);
	if ((found.kind === "none" || above) && within(start, rules.trees)) {
		return {
			top: start,
			refused: `${start} lies where the work tool cuts trees but holds no .git, as when a command removed it, so git won't run there: a .git put back later could name a git folder of a command's own. Release the tree and cut it again.`,
		};
	}
	if (found.kind === "none") return { ...outside(args), unrooted: found.at };
	if (found.kind === "link") {
		return {
			top: found.top,
			refused: `${found.top}'s .git is a link, which pi won't follow outside the sandbox: git would run whatever settings it leads to.`,
		};
	}
	if (found.kind === "repository") {
		const elsewhere = redirected(found.top, found.git);
		if (elsewhere) return elsewhere;
		if (within(found.top, rules.trees)) {
			return {
				top: found.top,
				refused: `${found.top} lies where the work tool cuts trees but holds a repository of its own rather than a worktree, so git won't run there. Release it and cut it again.`,
			};
		}
		if (
			rules.fenced &&
			!guardsGitFolder(real(found.git), rules.home, rules.disk)
		) {
			return {
				top: found.top,
				refused: `${found.top} is a repository the sandbox doesn't keep read-only, so a sandboxed command could have set what git runs there, and pi runs git outside the sandbox. ${CUT_ELSEWHERE}`,
			};
		}
		return outside(args);
	}
	const tree = treeGit(found.top, rules.home);
	if (!tree) {
		return {
			top: found.top,
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
			top: found.top,
			refused: `${found.top} is a worktree of ${tree.common}, which the sandbox doesn't keep read-only, so a sandboxed command could have set what git runs there, and pi runs git outside the sandbox. ${CUT_ELSEWHERE}`,
		};
	}
	return outside([
		`--git-dir=${tree.gitDir}`,
		`--work-tree=${found.top}`,
		...args,
	]);
}

/**
 * The top of the repository whose git `gitRun` won't run in `folder`,
 * or undefined where it may: where `folder`'s work lives, which a
 * refused git can't say for itself.
 */
export function refusedIn(folder: string, rules: GitRules): string | undefined {
	const run = gitRun(folder, [], rules);
	return "refused" in run ? run.top : undefined;
}

/** The exit code a refused git answers with, as a shell's for a command it won't run. */
export const GIT_REFUSED = 126;

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
	const held = heldGit(rules, cwd);
	return (command, args) => {
		const hold = held(command, args);
		if ("refused" in hold) return Promise.resolve(hold.refused);
		return exec(command, [...hold.args]);
	};
}

/** A command's arguments as they may run, or the answer it gets instead. */
export type Held =
	| {
			args: readonly string[];
			/**
			 * Where no git stood at or above when it was asked, as it really
			 * is, and git's arguments to run inside it: a queued git runs
			 * there rather than through the path it was given, whose links a
			 * command could repoint while it waits.
			 */
			unrooted?: { folder: string; args: readonly string[] };
	  }
	| { refused: ExecResult };

/**
 * What `guardedExec` does to each command before it runs, apart from
 * running it: git's arguments as `gitRun` answers them, from `cwd` or
 * pi's own folder under the rules `rules` gives at each call, or its
 * refusal; any other program's as they are.
 */
export function heldGit(
	rules: () => GitRules,
	cwd?: string,
): (command: string, args: readonly string[]) => Held {
	return (command, args) => {
		if (command !== "git") return { args };
		const run = gitRun(gitFolder(cwd ?? process.cwd(), args), args, rules());
		if ("refused" in run) {
			return {
				refused: { code: GIT_REFUSED, stdout: "", stderr: run.refused },
			};
		}
		return run.unrooted === undefined
			? { args: run.args }
			: {
					args: run.args,
					unrooted: { folder: run.unrooted, args: withoutFolders(run.args) },
				};
	};
}

/**
 * `args` with each folder `-C` names left out, read as `gitFolder`
 * reads them, for a git run in the folder they lead to.
 */
export function withoutFolders(args: readonly string[]): string[] {
	const kept: string[] = [];
	let at = 0;
	for (; at < args.length && args[at]?.startsWith("-"); at++) {
		const arg = args[at] ?? "";
		if (arg === "-C") {
			at++;
		} else if (arg === "-c") {
			kept.push(arg, args[at + 1] ?? "");
			at++;
		} else {
			kept.push(arg);
		}
	}
	return [...kept, ...args.slice(at)];
}
