/**
 * Walks of World's git objects: which steps of a command walk them, what
 * each walk does, and whether a search covers the whole of World, or
 * the whole home folder that holds it.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { mainFetchOf } from "./fetched-git.mjs";
import type { Walk } from "./needs.ts";
import { runSteps, shellSteps } from "./steps.ts";

/** A World checkout's root: its folder, or a tree's `src`. */
const WORLD_ROOT = /\/world(?:\/trees\/[^/]+\/src|\/src)?\/?$/;

/** rg's options that take the next word as their value. */
const RG_VALUED = new Set([
	"-e",
	"-f",
	"-g",
	"-t",
	"-T",
	"-m",
	"-A",
	"-B",
	"-C",
	"-j",
	"-M",
	"-E",
	"--glob",
	"--iglob",
	"--type",
	"--type-not",
	"--max-count",
	"--context",
	"--after-context",
	"--before-context",
	"--threads",
	"--max-columns",
	"--regexp",
	"--file",
	"--encoding",
]);

/**
 * Whether a command searches the whole of a World checkout: `rg` or
 * `git grep` run at a checkout's root, naming no narrower path, either
 * from where it runs or after a `cd` (or `-C`) to that root. Over a
 * checkout this size one reads gigabytes of files, and several at once
 * piled on a machine whose CPU the queue was holding for builds
 * (P9R1KI, 01:16 on 8 November). A search of one zone is left alone,
 * as a look is.
 */
export function searchesWorldWhole(command: string, where: Where): boolean {
	const expand = (path: string) =>
		path.replace(/^~(?=\/|$)/, where.home).replace(/\$HOME\b/, where.home);
	const atRoot = (path: string | undefined) =>
		(path?.startsWith(join(where.home, WORLD_FOLDER)) ?? false) &&
		WORLD_ROOT.test(path ?? "");
	let folder = where.cwd;
	for (const whole of shellSteps(command)) {
		const words = whole.trim().split(/\s+/).filter(Boolean);
		if (words[0] === "cd" || words[0] === "pushd") {
			const to = words[1] ? expand(words[1]) : where.home;
			folder = isAbsolute(to) ? resolve(to) : folder && resolve(folder, to);
			continue;
		}
		if (words[0] === "rg") {
			if (atRoot(folder) && narrowest(words.slice(1), RG_VALUED) <= 1) {
				return true;
			}
			continue;
		}
		if (words[0] !== "git") continue;
		let at = folder;
		let next = 1;
		while (words[next]?.startsWith("-")) {
			if (words[next] === "-C") {
				const to = expand(words[next + 1] ?? "");
				at = isAbsolute(to) ? resolve(to) : at && resolve(at, to);
				next += 2;
			} else next += words[next] === "-c" ? 2 : 1;
		}
		if (words[next] !== "grep") continue;
		const rest = words.slice(next + 1);
		if (atRoot(at) && !rest.includes("--") && narrowest(rest, RG_VALUED) <= 1) {
			return true;
		}
	}
	return false;
}

/**
 * A search of a whole home folder or disk: the tool that runs it, and
 * the folder it starts from.
 */
export interface HomeSearch {
	readonly tool: string;
	readonly root: string;
}

/**
 * The deepest a search from a home folder goes and is still a look: to
 * `~/world/trees`, never into a tree's files.
 */
const SHALLOW_DEPTH = 2;

/** Each search tool read for a home walk, with its options that take the next word as their value. */
const SEARCH_VALUED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["rg", new Set([...RG_VALUED, "-d", "--max-depth", "--maxdepth"])],
	[
		"grep",
		new Set([
			...["-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D"],
			...["--regexp", "--file", "--max-count", "--context"],
			...["--after-context", "--before-context"],
		]),
	],
	[
		"fd",
		new Set([
			...["-e", "-t", "-E", "-d", "-j", "-S", "-o", "-c"],
			...["--extension", "--type", "--exclude", "--max-depth"],
			...["--min-depth", "--exact-depth", "--threads", "--size"],
			...["--changed-within", "--changed-before", "--owner", "--color"],
			...["--base-directory", "--search-path"],
		]),
	],
]);

/** Each tool's options that give its pattern, so every word it names is a path. */
const GIVES_PATTERN = new Set(["-e", "-f", "--regexp", "--file", "--files"]);

/** Each tool's options that limit how deep it goes. */
const DEPTH = new Set(["-d", "--max-depth", "--maxdepth", "--exact-depth"]);

/** grep's options that have it search the folders it names. */
const RECURSIVE = /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--(?:dereference-)?recursive)$/;

/** What a step runs under before its search: a time limit, a lower priority, `time`, `command`. */
const UNDER =
	/^(?:(?:g?timeout(?:\s+-[sk]\s+\S+|\s+-\S+)*\s+\S+|nice(?:\s+-n\s*\S+|\s+-\d+)?|time|command|nohup)\s+)+/;

/** Where a search's words end: a redirection, as `2>/dev/null`, or input. */
const WORDS_END = /^(?:\d|&)?>|^</;

/**
 * Whether a command searches a whole home folder or the disk: `find`,
 * `rg`, a recursive `grep` or `fd` started from `/`, the home or a
 * folder holding it, by a path it names or, naming none, the folder it
 * runs in after any `cd`. Over a home folder one walks every World
 * checkout beside every cache: at 18:56 on 23 November an agent's
 * `find ~ -maxdepth 6 -path '*cadence*'` held its call 60 s and ran on
 * past its timeout (4UKB4W). A search kept within
 * {@link SHALLOW_DEPTH} levels only lists folders, and is left alone,
 * as a search of a narrower folder is. A path named through a variable
 * other than `$HOME` is unknown, so it is never read as the home.
 */
export function searchesHomeWhole(
	command: string,
	where: Where,
): HomeSearch | undefined {
	const pathOf = (word: string, from: string | undefined) => {
		const expanded = word
			.replace(/^~(?=\/|$)/, where.home)
			.replace(/^\$(?:HOME\b|\{HOME\})/, where.home);
		if (expanded.includes("$") || expanded.startsWith("~")) return undefined;
		if (isAbsolute(expanded)) return resolve(expanded);
		return from === undefined ? undefined : resolve(from, expanded);
	};
	const holdsHome = (path: string | undefined) =>
		path !== undefined &&
		(path === where.home ||
			where.home.startsWith(path.endsWith("/") ? path : `${path}/`));
	let folder = where.cwd;
	for (const whole of shellSteps(command)) {
		const words = whole.trim().replace(UNDER, "").split(/\s+/).filter(Boolean);
		const [tool = "", ...rest] = words;
		if (tool === "cd" || tool === "pushd") {
			folder = rest[0] ? pathOf(rest[0], folder) : where.home;
			continue;
		}
		const search = tool === "find" ? findOf(rest) : searchOf(tool, rest);
		if (search === undefined) continue;
		if (search.depth !== undefined && search.depth <= SHALLOW_DEPTH) continue;
		const roots =
			search.paths.length > 0
				? search.paths.map((path) => pathOf(path, folder))
				: [folder];
		const root = roots.find(holdsHome);
		if (root !== undefined) return { tool, root };
	}
	return undefined;
}

/** The paths a search names, and how deep it goes when it says. */
interface Search {
	readonly paths: readonly string[];
	readonly depth?: number;
}

/**
 * What a `find` searches: the words before its first test or action,
 * past its own options, and its `-maxdepth`.
 */
function findOf(words: readonly string[]): Search {
	let at = 0;
	while (/^-(?:[HLP]|O\d|D)$/.test(words[at] ?? "")) {
		at += words[at] === "-D" ? 2 : 1;
	}
	const paths: string[] = [];
	for (; at < words.length; at += 1) {
		const word = words[at] ?? "";
		if (/^[-(!]|^\\\(/.test(word) || WORDS_END.test(word)) break;
		paths.push(word);
	}
	const limit = words.indexOf("-maxdepth");
	const depth = limit < 0 ? undefined : Number(words[limit + 1]);
	return { paths, depth: Number.isNaN(depth) ? undefined : depth };
}

/**
 * What an `rg`, a recursive `grep` or an `fd` searches: the words it
 * names after its pattern, or all of them when an option gives the
 * pattern, and how deep it goes. Nothing for any other command, or a
 * `grep` that isn't recursive.
 */
function searchOf(tool: string, words: readonly string[]): Search | undefined {
	const valued = SEARCH_VALUED.get(tool);
	if (valued === undefined) return undefined;
	let recursive = tool !== "grep";
	let patternGiven = false;
	let depth: number | undefined;
	const named: string[] = [];
	for (let at = 0; at < words.length; at += 1) {
		const word = words[at] ?? "";
		if (WORDS_END.test(word)) break;
		if (word === "--") {
			named.push(...words.slice(at + 1).filter((w) => !WORDS_END.test(w)));
			break;
		}
		// fd runs what follows these on each file it finds.
		if (tool === "fd" && /^(?:-x|-X|--exec|--exec-batch)$/.test(word)) break;
		if (!word.startsWith("-") || word === "-") {
			named.push(word);
			continue;
		}
		const [option = word, inline] = word.startsWith("--")
			? word.split(/[=](.*)/s)
			: [word];
		if (tool === "grep" && RECURSIVE.test(word)) recursive = true;
		if (GIVES_PATTERN.has(option)) patternGiven = true;
		let value = inline;
		if (value === undefined && valued.has(option)) {
			at += 1;
			value = words[at];
		}
		if (tool !== "grep" && DEPTH.has(option)) depth = Number(value);
		const joined = /^-d(\d+)$/.exec(word)?.[1];
		if (tool !== "grep" && joined !== undefined) depth = Number(joined);
		if (option === "--search-path" && value !== undefined) {
			named.push(value);
			patternGiven ||= named.length === 1;
		}
	}
	if (!recursive) return undefined;
	const paths = patternGiven ? named : named.slice(1);
	return { paths, depth: Number.isNaN(depth) ? undefined : depth };
}

/**
 * Why a search of a whole home folder or the disk is refused, naming a
 * narrower folder to search, or nothing for any other command. Made
 * again unchanged it goes ahead, waiting its turn as a build does
 * (queue.ts's `kindOf`), since a search of everything is sometimes
 * what is wanted.
 */
export function homeSearchRefusal(
	command: string,
	where: Where,
): string | undefined {
	const search = searchesHomeWhole(command, where);
	if (search === undefined) return undefined;
	const root = search.root === where.home ? "~" : search.root;
	const whole =
		search.root === where.home
			? "the whole home folder"
			: "every home folder on the machine";
	return `This ${search.tool} searches every folder from ${root}, which takes in ${whole}, World's checkouts and every cache with it: on 23 November one such find held its call for 60 seconds and ran on past its timeout. Search a narrower folder instead, such as the repository you mean (~/src/<host>/<org>/<repo>) or one World zone, or keep it shallow: find ${root} -maxdepth 2, or --max-depth 2 for rg and fd. Made again unchanged, it waits its turn as a build does.`;
}

/**
 * How many words a search names besides its options: the pattern, then
 * any paths. A search naming only its pattern covers where it runs.
 */
function narrowest(
	words: readonly string[],
	valued: ReadonlySet<string>,
): number {
	let named = 0;
	for (let at = 0; at < words.length; at += 1) {
		const word = words[at] ?? "";
		if (/^[|;&>]|^\d?>/.test(word)) break;
		if (word.startsWith("-")) {
			if (valued.has(word)) at += 1;
			continue;
		}
		if (word === "." || word === "./") continue;
		named += 1;
	}
	return named;
}

/**
 * What a walk of World's objects does, for its place among the walks
 * waiting: `push`, every walk it runs is a push; `main-fetch`, every one
 * is a plain fetch of origin's main, which a fetch of main just made can
 * answer (see fetched.ts); `branch`, every one is a push, a fetch of
 * main or a branch's own work, and they aren't all pushes or all fetches:
 * a rebase, cherry-pick, revert, merge or `sparse-checkout`, or a fetch
 * of main beside a push; `other`, it walks for anything else, as a fetch
 * of another person's branch does. Nothing for a command that walks
 * none. A rebase or a fetch chained before a push is `branch`, since a
 * push's quick turn and small hold (job.ts's `isQuick`, needs.ts's
 * `PUSH_GIB`) would let the walk before it past every walk's limit. Its
 * push still leaves out its LFS scan ({@link pushesWorld}).
 */
export function walkOf(
	command: string,
	where: Where = { home: homedir() },
): Walk | undefined {
	const walks = worldWalks(runSteps(command), where).map(walkDoes);
	if (walks.length === 0) return undefined;
	if (walks.every((walk) => walk === "main-fetch")) return "main-fetch";
	if (walks.includes("other")) return "other";
	return walks.every((walk) => walk === "push") ? "push" : "branch";
}

/**
 * Whether a command pushes to World, alone or after other walks: such a
 * command is given the queue's push hooks (pushes.ts), so its push
 * leaves out the LFS scan when it holds no LFS file, whatever it's
 * chained after.
 */
export function pushesWorld(
	command: string,
	where: Where = { home: homedir() },
): boolean {
	return worldWalks(runSteps(command), where).some(
		(walk) => walk[2] === "push",
	);
}

/**
 * Whether a command pushes to World past its pre-push hooks: a push of
 * World whose last word on them is `--no-verify`. dev's hooks check a
 * push's ancestry and its cutoff as well as scanning for LFS files, and
 * a push holding no LFS file already leaves the scan out (pushes.ts),
 * so the flag gives those checks up for nothing. On 6 November 5
 * sessions had pushed 20 times with it. `-n` is a dry run for a push,
 * not this.
 */
export function skipsWorldPushHooks(
	command: string,
	where: Where = { home: homedir() },
): boolean {
	return worldWalks(runSteps(command), where).some(
		(walk) => walk[2] === "push" && lastSayOnHooks(walk[3] ?? "") === NO_VERIFY,
	);
}

/** The flag that has a push skip its pre-push hook. */
const NO_VERIFY = "--no-verify";

/** The last of `--verify` and `--no-verify` in a push's words, as git takes it. */
function lastSayOnHooks(rest: string): string | undefined {
	return rest
		.split(/\s+/)
		.filter((word) => word === NO_VERIFY || word === "--verify")
		.pop();
}

/**
 * The subcommands that work on a branch of one's own, which wait among
 * pushes rather than behind them: with one walk let run while memory
 * stalls, a rebase ranked behind pushes would wait for as long as
 * pushes kept arriving.
 */
const BRANCH_WORK: ReadonlySet<string> = new Set([
	"rebase",
	"cherry-pick",
	"revert",
	"merge",
	"sparse-checkout",
]);

/** What one walk does, from its git subcommand and what follows it. */
function walkDoes(walk: RegExpExecArray): Walk {
	if (walk[2] === "push") return "push";
	if (BRANCH_WORK.has(walk[2] ?? "")) return "branch";
	return walk[2] === "fetch" && answersFetch(walk) ? "main-fetch" : "other";
}

/** A redirection, as `2>&1`, `>$L` or `2>` before its file. */
const REDIRECT = /^(?:\d|&)?>>?/;

/**
 * Whether fetched-git.mjs would answer a walk, were a fetch of main just
 * made: git run by name, found on the PATH rather than by a path, with
 * the arguments the shell would give it read as a plain fetch of
 * origin's main by fetched-git.mjs's own `mainFetchOf`. A fetch it
 * can't answer runs the real git past the walks' count, so a fetch read
 * as main's here must be one it answers.
 */
function answersFetch(walk: RegExpExecArray): boolean {
	if (walk.input[walk.index - 1] === "/") return false;
	const words = [walk[1], walk[2], walk[3]]
		.join(" ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	const args: string[] = [];
	for (let at = 0; at < words.length; at += 1) {
		const word = words[at];
		if (word === undefined) continue;
		if (REDIRECT.test(word)) {
			// A bare operator's file is the next word.
			if (/^(?:\d|&)?>>?$/.test(word)) at += 1;
			continue;
		}
		args.push(word);
	}
	return mainFetchOf(args) !== undefined;
}

/**
 * Where a command runs, to read the folders it names: its own folder,
 * when known, and the home that `~` and `$HOME` name.
 */
export interface Where {
	readonly cwd?: string;
	readonly home: string;
}

/** World's checkouts, its git and its trees, as a folder of the home. */
const WORLD_FOLDER = "world";

/**
 * A git command that walks a repository's objects, past options such as
 * `-C <dir>` and `-c <key>=<value>`: a push (the LFS pre-push hook runs
 * `git rev-list --objects` over what it sends), a fetch or pull, a
 * clone, the repacks, and what merges trees or fills a sparse checkout:
 * a rebase, a cherry-pick, a revert, a merge and `sparse-checkout`. Two World
 * rebases held 3.8 and 3.9 GB each beside other walks at 06:08 on 21
 * November, with no turn (80ECO2). What only steers one of those or
 * reads where it stands walks nothing, and goes free, so a checkout
 * stuck mid-rebase can be put back while memory is pressed: `--abort`,
 * `--quit`, `--show-current-patch` and `--edit-todo`, `sparse-checkout`
 * alone, its `list` and `check-rules`, and help, asked before or after
 * any of these subcommands. `--continue` and `--skip` go on applying
 * commits, so they walk. Options are kept, to read the folders `-C`,
 * `--git-dir` and `--work-tree` name, then the subcommand, and the rest,
 * to read a path it fetches from or clones and what it fetches. Each
 * option reads one way only: `-c`, `-C`, `--git-dir`, `--work-tree` and
 * `--namespace` take the word after them unless they hold it after an
 * `=`, and no other option is read as one of them, so a long run of
 * options can't make the match backtrack.
 */
export const GIT_WALK =
	/(?<![\w.-])git((?:\s+(?:-C\s+\S+|-c\s+\S+|--(?:git-dir|work-tree|namespace)(?:=\S+|\s+\S+)|--(?!(?:git-dir|work-tree|namespace|help)(?![\w-]))\w[\w-]*(?:=\S+)?|-(?![cCh](?:\s|$))\w[\w-]*(?:=\S+)?))*)\s+(push|fetch|pull|clone|gc|repack|pack-objects|(?:rebase|cherry-pick|revert|merge)(?!\s+--(?:abort|quit|show-current-patch|edit-todo)(?![\w-]))|sparse-checkout(?!\s+(?:list|check-rules)(?![\w-])|\s*$))(?!\s+(?:--help|-h)(?![\w-]))(?![\w.=-])(.*)$/;

/** A variable set as a step's first word, as `T=~/world/trees/a/src`. */
const SETS = /^(?:export\s+)?([A-Za-z_]\w*)=(\S*)(?:\s+|$)/;

/** A variable, as `$T` or `${T}`. */
const VARIABLE = /\$(?:\{(\w+)\}|(\w+))/g;

/**
 * The walks of World's git objects a command's steps run: each step
 * running {@link GIT_WALK} in a World checkout, by the folder it runs in, a `cd`
 * before it or its own `-C`, or naming a path in one, as a fetch from
 * or a clone of `~/world/git` does. Each step's folder is followed from
 * the command's own, through each `cd` and the variables set on the
 * way; a folder named through any other variable is unknown, so it
 * counts only for the paths the step names outright. Every other
 * repository's git is left alone.
 */
export function worldWalks(
	steps: readonly string[],
	where: Where,
): RegExpExecArray[] {
	const walks: RegExpExecArray[] = [];
	const world = join(where.home, WORLD_FOLDER);
	const inWorld = (path: string | undefined) =>
		path !== undefined && (path === world || path.startsWith(`${world}/`));
	const variables = new Map([["HOME", where.home]]);
	const pathOf = (word: string, from: string | undefined) => {
		let unknown = false;
		const expanded = word
			.replace(/^file:\/\//, "")
			.replace(/^~(?=\/|$)/, where.home)
			.replace(VARIABLE, (_, braced, bare) => {
				const value = variables.get(braced ?? bare);
				if (value === undefined) unknown = true;
				return value ?? "";
			});
		if (unknown) return undefined;
		if (isAbsolute(expanded)) return resolve(expanded);
		return from === undefined ? undefined : resolve(from, expanded);
	};
	let folder = where.cwd;
	for (const whole of steps) {
		let step = whole.trim();
		for (let set = SETS.exec(step); set !== null; set = SETS.exec(step)) {
			const [matched, name = "", raw = ""] = set;
			const value = raw.startsWith("$(") ? undefined : pathOf(raw, "/");
			if (value === undefined) variables.delete(name);
			else variables.set(name, value);
			step = step.slice(matched.length);
		}
		const words = step.split(/\s+/);
		if (words[0] === "cd" || words[0] === "pushd") {
			folder = words[1] ? pathOf(words[1], folder) : where.home;
			continue;
		}
		const walk = GIT_WALK.exec(step);
		if (walk === null) continue;
		const options = (walk[1] ?? "").trim().split(/\s+/);
		let at = folder;
		const named: (string | undefined)[] = [];
		options.forEach((option, index) => {
			const next = options[index + 1] ?? "";
			if (option === "-C") at = pathOf(next, at);
			if (option === "--git-dir" || option === "--work-tree") {
				named.push(pathOf(next, at));
			}
			const dir = /^--(?:git-dir|work-tree)=(.+)$/.exec(option)?.[1];
			if (dir !== undefined) named.push(pathOf(dir, at));
		});
		for (const word of (walk[3] ?? "").trim().split(/\s+/)) {
			if (/^(?:[/~.$]|file:\/\/)/.test(word)) named.push(pathOf(word, at));
		}
		if (inWorld(at) || named.some(inWorld)) walks.push(walk);
	}
	return walks;
}
