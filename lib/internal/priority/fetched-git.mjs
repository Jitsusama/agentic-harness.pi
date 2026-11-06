/**
 * git, first on the PATH of a shell whose fetch of World's main another
 * job has just made (fetched.ts).
 *
 * A plain fetch of origin's main in World's repository is answered from
 * the `origin/main` the other fetch left: FETCH_HEAD is written as git
 * writes it, and a line says the fetch was answered. Every other git
 * command, and a fetch of anything else, runs the real git, found on the
 * PATH past this one's folder, with its exit kept.
 *
 * The queue reads a fetch as main's the same way (queue.ts's
 * `fetchesOnlyMain`), so the fetch it answers is the one this answers.
 *
 * Run as `node fetched-git.mjs <its folder> <World's git> <git's args>`
 * by the `git` wrapper fetched.ts places. Plain `.mjs` because node runs
 * it directly, from where consumers install this package, and won't
 * strip types there.
 */

import { spawnSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** A fetch's options that change nothing of what it leaves. */
const PLAIN_OPTIONS = new Set([
	"-q",
	"--quiet",
	"-v",
	"--verbose",
	"-n",
	"--no-tags",
	"--progress",
	"--no-progress",
	"-f",
	"--force",
	"--no-write-fetch-head",
	"--no-auto-gc",
	"--no-auto-maintenance",
	"--show-forced-updates",
	"--no-show-forced-updates",
]);

/** A refspec naming origin's main, into its own remote-tracking ref. */
const MAIN_REFSPEC =
	/^\+?(?:refs\/heads\/)?main(?::refs\/remotes\/origin\/main)?$/;

/**
 * What a git command line asks, when it is a plain fetch of origin's
 * main: the folder `-C` names, if any, whether it is quiet, and whether
 * it writes FETCH_HEAD. Nothing for any other command.
 *
 * @param {readonly string[]} args
 * @returns {{ at: string | undefined, quiet: boolean, writesHead: boolean } | undefined}
 */
export function mainFetchOf(args) {
	let at;
	let index = 0;
	for (; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "fetch") break;
		if (arg === "-C" || arg === "-c") {
			if (index + 1 >= args.length) return undefined;
			if (arg === "-C") {
				const folder = args[index + 1];
				at =
					at === undefined || folder.startsWith("/")
						? folder
						: `${at}/${folder}`;
			}
			index += 1;
			continue;
		}
		if (arg === "--no-pager") continue;
		return undefined;
	}
	if (args[index] !== "fetch") return undefined;
	let quiet = false;
	let writesHead = true;
	const named = [];
	for (const arg of args.slice(index + 1)) {
		if (arg.startsWith("-")) {
			if (!PLAIN_OPTIONS.has(arg)) return undefined;
			if (arg === "-q" || arg === "--quiet") quiet = true;
			if (arg === "--no-write-fetch-head") writesHead = false;
			continue;
		}
		named.push(arg);
	}
	const [remote, ...refspecs] = named;
	if (remote !== "origin" || refspecs.length === 0) return undefined;
	if (!refspecs.every((refspec) => MAIN_REFSPEC.test(refspec)))
		return undefined;
	return { at, quiet, writesHead };
}

/**
 * A remote's URL as git shows it: without its credentials, a trailing
 * slash or `.git`.
 *
 * @param {string} url
 */
export function shownUrl(url) {
	return url
		.replace(/\/\/[^/@]*@/, "//")
		.replace(/\/+$/, "")
		.replace(/\.git$/, "");
}

/**
 * The FETCH_HEAD line git writes for a fetch of main from `url`.
 *
 * @param {string} commit
 * @param {string} url
 */
export function fetchHeadLine(commit, url) {
	return `${commit}\t\tbranch 'main' of ${shownUrl(url)}\n`;
}

/**
 * The PATH without `folder`, so the real git is found.
 *
 * @param {string} path
 * @param {string} folder
 */
export function pathPast(path, folder) {
	return path
		.split(":")
		.filter((part) => part !== folder && part !== "")
		.join(":");
}

/**
 * Answers a fetch of main from `origin/main`, or says it can't: not in
 * World's repository, or no such ref.
 *
 * @param {{ at: string | undefined, quiet: boolean, writesHead: boolean }} fetch
 * @param {string} world
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function answer(fetch, world, env) {
	const git = (/** @type {string[]} */ ...args) => {
		const ran = spawnSync(
			"git",
			[...(fetch.at === undefined ? [] : ["-C", fetch.at]), ...args],
			{ encoding: "utf8", env, timeout: 10_000 },
		);
		return ran.status === 0 ? ran.stdout.trim() : undefined;
	};
	const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
	if (common === undefined) return false;
	try {
		if (realpathSync(common) !== realpathSync(world)) return false;
	} catch {
		// Either folder unreadable: not World's, as far as this can tell.
		return false;
	}
	const commit = git(
		"rev-parse",
		"-q",
		"--verify",
		"refs/remotes/origin/main^{commit}",
	);
	if (commit === undefined) return false;
	const url = git("config", "--get", "remote.origin.url") ?? "origin";
	if (fetch.writesHead) {
		const head = git(
			"rev-parse",
			"--path-format=absolute",
			"--git-path",
			"FETCH_HEAD",
		);
		if (head === undefined) return false;
		writeFileSync(head, fetchHeadLine(commit, url));
	}
	if (!fetch.quiet) {
		process.stderr.write(`From ${shownUrl(url)}\n`);
	}
	process.stderr.write(
		`Answered by the machine queue: a fetch of origin main ended moments ago, and origin/main is ${commit.slice(0, 12)}.\n`,
	);
	return true;
}

/**
 * Runs as git: answers a fetch of main, or runs the real git with the
 * arguments given and leaves with its exit.
 *
 * @param {readonly string[]} argv
 */
function run(argv) {
	const [folder = "", world = "", ...args] = argv;
	const env = {
		...process.env,
		PATH: pathPast(process.env.PATH ?? "", folder),
	};
	const fetch = mainFetchOf(args);
	if (fetch && answer(fetch, world, env)) return;
	const ran = spawnSync("git", args, { stdio: "inherit", env });
	if (ran.signal) {
		process.kill(process.pid, ran.signal);
		return;
	}
	process.exitCode = ran.status ?? 127;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	run(process.argv.slice(2));
}
