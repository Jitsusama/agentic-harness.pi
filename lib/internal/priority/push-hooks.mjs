/**
 * Every git hook of a shell whose push of World waits its turn in the
 * machine's queue (pushes.ts), run as `core.hooksPath`.
 *
 * World's pre-push runs each hook in `pre-push.d`, and the first, its
 * LFS hook, asks `git lfs ls-files OLD NEW` whether the push holds an
 * LFS pointer. That walks every tree `OLD` reaches to leave them out, a
 * whole World tree, and under the machine's load it took over 90
 * minutes for a push of 4 commits touching 5 paths (5 November 2026,
 * 80ECO2), while `git log` over the same range took 1.6 s.
 *
 * So a push of one existing branch whose new commits add no LFS pointer,
 * touch no path LFS filters and change no `.gitattributes` runs every
 * pre-push hook but those that run `git lfs pre-push`, from where its
 * repository keeps them, as the repository's own pre-push would. Any
 * other push, and any doubt, runs the repository's own pre-push whole.
 * Every other hook name runs the repository's own hook of that name.
 *
 * Run as `node push-hooks.mjs <hook's name> <hook's args>` by the
 * wrappers pushes.ts places. Plain `.mjs` because node runs it directly,
 * from where consumers install this package, and won't strip types there.
 */

import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The variable holding how many `GIT_CONFIG_COUNT` settings there were
 * before pushes.ts added `core.hooksPath` as the last of them.
 */
export const PRIOR_VARIABLE = "PI_PUSH_HOOKS_PRIOR";

/** The hook names git runs from a local repository's hooks folder. */
export const HOOK_NAMES = [
	"applypatch-msg",
	"pre-applypatch",
	"post-applypatch",
	"pre-commit",
	"pre-merge-commit",
	"prepare-commit-msg",
	"commit-msg",
	"post-commit",
	"pre-rebase",
	"post-checkout",
	"post-merge",
	"pre-push",
	"reference-transaction",
	"post-rewrite",
	"pre-auto-gc",
	"post-index-change",
	"sendemail-validate",
	"push-to-checkout",
];

/** How long one of the range's reads may take before it counts as doubt. */
const READ_MS = 120_000;

/** The first line of every LFS pointer file. */
const POINTER = "version https://git-lfs.github.com/spec/";

/** A pointer file is small; git-lfs reads no more than this of a blob. */
const POINTER_MAX_BYTES = 1024;

/** A full object name, SHA-1 or SHA-256. */
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** An object name of zeros: a ref created or deleted. */
const NONE = /^0+$/;

/**
 * The environment without the `core.hooksPath` setting pushes.ts added,
 * so git finds the repository's own hooks and they run as they would
 * have.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function withoutOurs(env) {
	const prior = Number.parseInt(env[PRIOR_VARIABLE] ?? "", 10);
	const kept = { ...env };
	delete kept[PRIOR_VARIABLE];
	if (!Number.isInteger(prior) || prior < 0) return kept;
	delete kept[`GIT_CONFIG_KEY_${prior}`];
	delete kept[`GIT_CONFIG_VALUE_${prior}`];
	if (prior === 0) delete kept.GIT_CONFIG_COUNT;
	else kept.GIT_CONFIG_COUNT = String(prior);
	return kept;
}

/**
 * A git command's output, or nothing when it failed or ran too long.
 *
 * @param {readonly string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {string | Buffer} [input]
 * @returns {string | undefined}
 */
function git(args, env, input) {
	const run = spawnSync("git", args, {
		env,
		input,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		timeout: READ_MS,
		stdio: ["pipe", "pipe", "ignore"],
	});
	return run.status === 0 ? run.stdout : undefined;
}

/**
 * What the new commits of `old..new` change: each path, and each blob a
 * path is left holding. A merge counts for what it holds that none of
 * its parents did, since the rest came from commits in the range or
 * already on the remote. Nothing when the range can't be read.
 *
 * @param {string} old
 * @param {string} now
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ paths: string[], blobs: string[] } | undefined}
 */
export function changedIn(old, now, env) {
	const raw = git(
		[
			"log",
			"-z",
			"--format=",
			"--raw",
			"--no-abbrev",
			"--no-renames",
			"--diff-merges=c",
			`${old}..${now}`,
		],
		env,
	);
	if (raw === undefined) return undefined;
	const paths = new Set();
	const blobs = new Set();
	const fields = raw.split("\0");
	for (let at = 0; at < fields.length; at += 1) {
		const header = fields[at].replace(/^\n+/, "");
		if (!header.startsWith(":")) continue;
		const path = fields[at + 1];
		if (path === undefined) return undefined;
		at += 1;
		paths.add(path);
		const words = header.replace(/^:+/, "").split(" ");
		const blob = words.at(-2);
		if (blob === undefined || !OID.test(blob)) return undefined;
		if (!NONE.test(blob)) blobs.add(blob);
	}
	return { paths: [...paths], blobs: [...blobs] };
}

/**
 * Whether any of `blobs` is an LFS pointer, read as git-lfs reads one:
 * a small blob that opens with the pointer's first line. Nothing when
 * they can't be read.
 *
 * @param {readonly string[]} blobs
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean | undefined}
 */
export function holdsPointer(blobs, env) {
	if (blobs.length === 0) return false;
	const sizes = git(
		["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
		env,
		`${blobs.join("\n")}\n`,
	);
	if (sizes === undefined) return undefined;
	const small = [];
	for (const line of sizes.split("\n")) {
		if (line === "") continue;
		const [name, type, size] = line.split(" ");
		if (type === undefined || size === undefined) return undefined;
		if (type === "blob" && Number(size) <= POINTER_MAX_BYTES) small.push(name);
	}
	for (const blob of small) {
		const text = git(["cat-file", "blob", blob], env);
		if (text === undefined) return undefined;
		if (text.startsWith(POINTER)) return true;
	}
	return false;
}

/**
 * Whether LFS filters any of `paths`, by the attributes at `commit` and
 * those the repository and the user keep. Nothing when that can't be
 * read.
 *
 * @param {readonly string[]} paths
 * @param {string} commit
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean | undefined}
 */
export function filtersAny(paths, commit, env) {
	if (paths.length === 0) return false;
	const said = git(
		["check-attr", "-z", "--stdin", `--source=${commit}`, "filter"],
		env,
		`${paths.join("\0")}\0`,
	);
	if (said === undefined) return undefined;
	const fields = said.split("\0");
	for (let at = 0; at + 2 < fields.length; at += 3) {
		if (fields[at + 2] === "lfs") return true;
	}
	return false;
}

/**
 * Why a push, by the lines git gives pre-push on its stdin, can leave
 * out the LFS hook's scan, or nothing when it can't. It can only when it
 * updates one existing branch, as the LFS hook's own fast path asks, and
 * its new commits add no pointer, touch no path LFS filters before or
 * after, and change no `.gitattributes`.
 *
 * @param {string} lines
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
export function lfsScanSpared(lines, env) {
	const updates = lines.split("\n").filter((line) => line !== "");
	if (updates.length !== 1) return undefined;
	const words = updates[0].split(" ");
	if (words.length !== 4) return undefined;
	const [localRef, now, remoteRef, old] = words;
	if (
		!localRef.startsWith("refs/heads/") ||
		!remoteRef.startsWith("refs/heads/")
	) {
		return undefined;
	}
	if (!OID.test(now) || !OID.test(old) || NONE.test(now) || NONE.test(old)) {
		return undefined;
	}
	if (now === old) return undefined;
	if (git(["cat-file", "-e", `${old}^{commit}`], env) === undefined)
		return undefined;
	const changed = changedIn(old, now, env);
	if (changed === undefined) return undefined;
	if (
		changed.paths.some(
			(path) => path === ".gitattributes" || path.endsWith("/.gitattributes"),
		)
	) {
		return undefined;
	}
	if (filtersAny(changed.paths, now, env) !== false) return undefined;
	if (filtersAny(changed.paths, old, env) !== false) return undefined;
	if (holdsPointer(changed.blobs, env) !== false) return undefined;
	return `its ${changed.paths.length} changed paths hold no LFS file`;
}

/**
 * Whether `file` is a file this user may run, following a link as
 * World's pre-push does.
 *
 * @param {string} file
 */
function runnable(file) {
	try {
		if (!statSync(file).isFile()) return false;
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * The hooks a folder of them runs, in the order World's pre-push runs
 * them: every runnable file in it, sorted by name.
 *
 * @param {string} folder
 * @returns {string[]}
 */
export function hooksIn(folder) {
	return readdirSync(folder)
		.sort()
		.map((name) => join(folder, name))
		.filter(runnable);
}

/**
 * Whether a hook hands the push to git-lfs, as World's LFS hook and the
 * one git-lfs installs do.
 *
 * @param {string} hook
 */
export function runsLfs(hook) {
	try {
		return readFileSync(hook, "utf8").includes("git lfs pre-push");
	} catch {
		return false;
	}
}

/**
 * Runs `hook` as git would have, with `input` on its stdin when given,
 * and gives its exit.
 *
 * @param {string} hook
 * @param {readonly string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {Buffer} [input]
 * @returns {number}
 */
function run(hook, args, env, input) {
	const ran = spawnSync(hook, args, {
		env,
		...(input === undefined
			? { stdio: "inherit" }
			: { input, stdio: ["pipe", "inherit", "inherit"] }),
	});
	return ran.status ?? 1;
}

/**
 * The repository's own pre-push, run hook by hook from its `pre-push.d`
 * leaving out those that run git-lfs, when the push spares their scan
 * and the repository's pre-push is the kind that runs that folder.
 * Otherwise the repository's own pre-push, whole.
 *
 * @param {string} hooks
 * @param {readonly string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {Buffer} input
 * @returns {number}
 */
export function prePush(hooks, args, env, input) {
	const own = join(hooks, "pre-push");
	const folder = join(hooks, "pre-push.d");
	const whole = () => (runnable(own) ? run(own, args, env, input) : 0);
	let dispatches = false;
	try {
		dispatches =
			readFileSync(own, "utf8").includes("pre-push.d") &&
			statSync(folder).isDirectory();
	} catch {
		return whole();
	}
	if (!dispatches) return whole();
	const spared = lfsScanSpared(input.toString("utf8"), env);
	if (spared === undefined) return whole();
	const common = git(
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		env,
	)?.trim();
	if (!common) return whole();
	const each = { ...env, GIT_COMMON_DIR: env.GIT_COMMON_DIR ?? common };
	const left = hooksIn(folder).filter(runsLfs);
	for (const hook of hooksIn(folder)) {
		if (left.includes(hook)) continue;
		const status = run(hook, args, each, input);
		if (status !== 0) return status;
	}
	if (left.length > 0) {
		process.stderr.write(`pre-push: left out the LFS scan, since ${spared}.\n`);
	}
	return 0;
}

/**
 * Runs the hook named `name` as the repository would have.
 *
 * @param {string} name
 * @param {readonly string[]} args
 * @param {NodeJS.ProcessEnv} given
 * @returns {number}
 */
export function hook(name, args, given) {
	const env = withoutOurs(given);
	const hooks = git(
		["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
		env,
	)?.trim();
	// Refused rather than run without the repository's hooks, which would
	// skip them all.
	if (!hooks) return 1;
	if (name === "pre-push") {
		let input;
		try {
			input = readFileSync(0);
		} catch {
			input = Buffer.alloc(0);
		}
		return prePush(hooks, args, env, input);
	}
	const own = join(hooks, name);
	return runnable(own) ? run(own, args, env) : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const [name, ...args] = process.argv.slice(2);
	process.exitCode = name ? hook(name, args, process.env) : 0;
}
