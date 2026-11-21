/**
 * Walks of World's git objects: which steps of a command walk them, what
 * each walk does, and whether a search covers the whole of World.
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
 * waiting: `push`, every walk it runs is a push or a fetch of origin's
 * main, at least one a push; `main-fetch`, every one is a plain fetch
 * of origin's main, which a fetch of main just made can answer (see
 * fetched.ts); `other`, it walks for anything else, as a fetch of
 * another person's branch does. Nothing for a command that walks none.
 */
export function walkOf(
	command: string,
	where: Where = { home: homedir() },
): Walk | undefined {
	const walks = worldWalks(runSteps(command), where).map(walkDoes);
	if (walks.length === 0) return undefined;
	if (walks.every((walk) => walk === "main-fetch")) return "main-fetch";
	return walks.every((walk) => walk !== "other") ? "push" : "other";
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

/** What one walk does, from its git subcommand and what follows it. */
function walkDoes(walk: RegExpExecArray): Walk {
	if (walk[2] === "push") return "push";
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
 * a rebase, a cherry-pick, a merge and `sparse-checkout`. Two World
 * rebases held 3.8 and 3.9 GB each beside other walks at 06:08 on 21
 * November, with no turn (80ECO2). Options are kept, to read the folder
 * `-C` names, then the subcommand, and the rest, to read a path it
 * fetches from or clones and what it fetches.
 */
export const GIT_WALK =
	/(?<![\w.-])git((?:\s+(?:-C\s+\S+|-c\s+\S+|--?[\w-]+(?:=\S+)?))*)\s+(push|fetch|pull|clone|gc|repack|pack-objects|rebase|cherry-pick|merge|sparse-checkout)(?![\w.=-])(.*)$/;

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
			if (option === "-C") at = pathOf(options[index + 1] ?? "", at);
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
