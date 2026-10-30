/**
 * Sending a session's VM checks of a public repository to the lent
 * builder by commit, rather than running them here.
 *
 * Through Nix's build hook, a VM check's inputs built here are uploaded
 * first: one took 1025 s that way, 16.7 minutes of it uploading at
 * 1.8 MB/s, against 60 s here. Built on the builder from the pushed
 * commit, which it fetches itself, the same check took 55 to 67 s warm
 * with 4 KB sent (5FWIUS, 29 October). `nix-offload there` does that,
 * and builds here instead when no builder can be reached.
 *
 * This module finds the steps of a command that build VM checks, and
 * says what each becomes; the interceptor asks git and the builder's
 * files whether it may.
 */

import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { count } from "../../ui/index.ts";
import { isRecord } from "../record.ts";
import { expandWith, type Step, wordsOf } from "../shell/steps.ts";
import { kindOf, LENDING_WAIT_MS } from "./queue.ts";
import { KERNEL, type Kernel, lendingSinceIn, offloadIn } from "./room.ts";

const run = promisify(execFile);

/** The package config section naming the repositories to send. */
export const REMOTE_CHECKS_SLUG = "remote-checks";

/** How often a call waiting on a lend looks again, in ms. */
export const LEND_POLL_MS = 2_000;

/** How long each git question may take before the command runs as written. */
const GIT_MS = 3_000;

/** A step's `nix build` of checks that may be sent by commit. */
export interface CheckBuild {
	/** The step it is, to be rewritten where it stands. */
	readonly step: Step;
	/** The folder of the flake it builds. */
	readonly flake: string;
	/**
	 * It builds the folder as it is (`path:`), untracked files and all,
	 * so the commit stands for it only when there are none.
	 */
	readonly whole: boolean;
	/**
	 * The commit it is pinned to with `?rev=`, as a ref to read in a
	 * folder, so what the tree holds now doesn't matter.
	 */
	readonly pin?: Pin;
	/** Each check's attribute, as `checks.<system>.<name>`. */
	readonly attributes: readonly string[];
	readonly printLogs: boolean;
	readonly keepGoing: boolean;
	/** Words run before it, as `timeout 600`, kept as written. */
	readonly before: readonly string[];
	/** The step's own redirections, kept as written. */
	readonly redirections: readonly string[];
}

/**
 * A step running `run-subtests` on a check of one flake whose folder is
 * known, which `run-subtests --there` can have built and run on the
 * builder, the pictures copied back.
 */
export interface SubtestsRun {
	readonly step: Step;
	/** The folder of the flake whose check it runs. */
	readonly flake: string;
}

/** What `nix-offload there` takes, by the words `--takes` prints. */
export interface Takes {
	/** A tree's own folder: base..HEAD and its changes go as a bundle. */
	readonly tree: boolean;
	/** `--apply` and `--out`, which `run-subtests --there` needs. */
	readonly subtests: boolean;
	/** It asks for a builder to be lent itself, and waits for one. */
	readonly wants: boolean;
	/** A folder no commit of origin's names goes as its files. */
	readonly folder: boolean;
}

/** An nix-offload that answers nothing, or is too old to say. */
export const TAKES_NOTHING: Takes = {
	tree: false,
	subtests: false,
	wants: false,
	folder: false,
};

/** A ref naming the commit a build is pinned to, and where to read it. */
export interface Pin {
	readonly ref: string;
	readonly folder: string;
}

/**
 * A flake's pin: a variable that holds a commit, a commit written out,
 * or `git rev-parse` written in place.
 */
const REV =
	/\?rev=(?:\$\{?(\w+)\}?|([0-9a-fA-F]{7,40})|\$\((git(?:\s+-C\s+[^\s()]+)?\s+rev-parse\s+[^\s()-][^\s()]*)\))(?=#|"|'|$)/;

/** What the repository a flake is in says of itself. */
export interface Repository {
	/** The flake is the repository's top folder. */
	readonly atTop: boolean;
	/** No file differs from HEAD, untracked ones counted where asked. */
	readonly clean: boolean;
	/** A remote branch contains HEAD, so the builder can fetch it. */
	readonly pushed: boolean;
	/** HEAD's full commit id. */
	readonly head: string;
	/** Origin's URL, or empty for a repository with none, such as a copy. */
	readonly origin: string;
}

/** An installable naming a check: a flake's folder, by a scheme or none. */
const CHECK = /^(git\+file:\/\/|path:)?([^#]*)#(checks\.[\w-]+\.[\w.+-]+)$/;

/** Flags that change nothing about what is built or where it lands. */
const PRINT_LOGS = new Set(["-L", "--print-build-logs"]);
const KEEP_GOING = new Set(["--keep-going", "-k"]);

/** A redirection written as one word, as `>$TMPDIR/x.log` or `2>&1`. */
const REDIRECTION = /^(?:\d?>>?|&>>?)\S+$/;

/** A redirection whose target is the next word. */
const REDIRECTS_TO = /^(?:\d?>>?|&>>?)$/;

/** A duration `timeout` takes, as `600` or `10m`. */
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

/**
 * The steps that build VM checks and could be sent: each a
 * `nix build --no-link` of checks of one flake whose folder is known,
 * optionally under `timeout <duration>` or `direnv exec .`, with no flag
 * that changes what is built. A step doing more runs as written.
 */
export function checkBuildsOf(
	steps: readonly Step[],
	home: string,
): CheckBuild[] {
	return steps.flatMap((step) => {
		const build = checkBuildOf(step, home);
		return build ? [build] : [];
	});
}

/** run-subtests' flags that need a person at the run, or say elsewhere. */
export const HERE_ONLY: ReadonlySet<string> = new Set([
	"-I",
	"--interactive",
	"-K",
	"--keep-machine-state",
	"--there",
	"--driver",
	"-h",
	"--help",
]);

/**
 * The steps running `run-subtests` that could be sent: the program,
 * optionally under `timeout <duration>`, `direnv exec .` or
 * `nix develop [<flake>] -c`, on a flake whose folder is known, with no
 * prompt asked for and no machines kept.
 */
export function subtestRunsOf(
	steps: readonly Step[],
	home: string,
): SubtestsRun[] {
	return steps.flatMap((step) => {
		const run = subtestsRunOf(step, home);
		return run ? [run] : [];
	});
}

function subtestsRunOf(step: Step, home: string): SubtestsRun | undefined {
	if (step.background) return undefined;
	const all = wordsOf(step.text).filter(
		(word, at, words) =>
			!REDIRECTION.test(word) &&
			!REDIRECTS_TO.test(word) &&
			!REDIRECTS_TO.test(words[at - 1] ?? ""),
	);
	let rest = all;
	if (rest[0] === "timeout" && DURATION.test(rest[1] ?? "")) {
		rest = rest.slice(2);
	}
	if (rest[0] === "direnv" && rest[1] === "exec" && rest[2] === ".") {
		rest = rest.slice(3);
	} else if (rest[0] === "nix" && rest[1] === "develop") {
		const run = rest.findIndex((word) => word === "-c" || word === "--command");
		if (run < 2 || run > 3) return undefined;
		rest = rest.slice(run + 1);
	}
	if (rest[0] !== "run-subtests") return undefined;
	const args = rest.slice(1);
	if (args.some((word) => HERE_ONLY.has(word))) return undefined;
	const expand = expandWith(step.vars, step.cwd, home);
	const at = args.indexOf("--flake");
	const written = at === -1 ? "." : expand(args[at + 1] ?? "");
	const folder =
		written === undefined
			? undefined
			: folderOf(written.replace(/^path:/, ""), step.cwd);
	const check = args.find(
		(word, index) =>
			!word.startsWith("-") &&
			args[index - 1] !== "--flake" &&
			args[index - 1] !== "--out",
	);
	if (folder === undefined || check === undefined) return undefined;
	return { step, flake: folder };
}

function checkBuildOf(step: Step, home: string): CheckBuild | undefined {
	// Piped, its log reads as the build's would; in the background, the
	// shell can't be counted on to wait for it.
	// A pin written in place has spaces, which the queue reads as prose.
	const unpinned = step.text.replace(new RegExp(REV.source, "g"), "");
	if (step.background || kindOf(unpinned) !== "vm-check") return undefined;
	const all = wordsOf(step.text);
	const redirections: string[] = [];
	const words: string[] = [];
	for (let at = 0; at < all.length; at++) {
		const word = all[at] ?? "";
		if (REDIRECTS_TO.test(word)) {
			redirections.push(word, all[++at] ?? "");
		} else if (REDIRECTION.test(word)) redirections.push(word);
		else words.push(word);
	}
	const before: string[] = [];
	let rest = words;
	if (rest[0] === "timeout" && DURATION.test(rest[1] ?? "")) {
		before.push(...rest.slice(0, 2));
		rest = rest.slice(2);
	}
	if (rest[0] === "direnv" && rest[1] === "exec" && rest[2] === ".") {
		rest = rest.slice(3);
	}
	if (rest[0] !== "nix" || rest[1] !== "build") return undefined;
	const expand = expandWith(step.vars, step.cwd, home);
	const attributes: string[] = [];
	const flakes = new Set<string>();
	const pins = new Set<string>();
	let pin: Pin | undefined;
	let whole = false;
	let noLink = false;
	let printLogs = false;
	let keepGoing = false;
	for (const word of rest.slice(2)) {
		if (word === "--no-link") noLink = true;
		else if (PRINT_LOGS.has(word)) printLogs = true;
		else if (KEEP_GOING.has(word)) keepGoing = true;
		else {
			const rev = REV.exec(word);
			const check = CHECK.exec(expand(word.replace(REV, "")) ?? "");
			const folder = check ? folderOf(check[2] ?? "", step.cwd) : undefined;
			if (!check?.[3] || folder === undefined) return undefined;
			if (check[1] === "path:") whole = true;
			if (rev) {
				const read = pinOf(rev, step, folder, home);
				if (!read || check[1] !== "git+file://") return undefined;
				pin = read;
			}
			pins.add(rev ? `${pin?.folder}\0${pin?.ref}` : "");
			attributes.push(check[3]);
			flakes.add(folder);
		}
	}
	const [flake] = flakes;
	const once = flakes.size === 1 && pins.size === 1;
	if (!noLink || flake === undefined || !once) return undefined;
	return {
		step,
		flake,
		whole,
		...(pin ? { pin } : {}),
		attributes,
		printLogs,
		keepGoing,
		before,
		redirections,
	};
}

/**
 * The commit a `?rev=` names: written out, read in the flake's folder;
 * or a variable set from `git [-C <folder>] rev-parse <ref>` earlier in
 * the command, read where that ran. Nothing for any other variable.
 */
function pinOf(
	rev: RegExpExecArray,
	step: Step,
	flake: string,
	home: string,
): Pin | undefined {
	const [, name, written, inline] = rev;
	if (written) return { ref: written, folder: flake };
	const substitution = inline
		? { command: inline, cwd: step.cwd, vars: step.vars }
		: name
			? step.substituted.get(name)
			: undefined;
	if (!substitution) return undefined;
	const expand = expandWith(substitution.vars, substitution.cwd, home);
	const words = wordsOf(substitution.command).map(expand);
	if (words.some((word) => word === undefined)) return undefined;
	const [git, ...args] = words as string[];
	let folder = substitution.cwd;
	if (args[0] === "-C") {
		folder = args[1] && isAbsolute(args[1]) ? args[1] : undefined;
		args.splice(0, 2);
	}
	const [verb, ref, ...more] = args;
	if (git !== "git" || verb !== "rev-parse" || !ref || more.length > 0) {
		return undefined;
	}
	if (ref.startsWith("-") || folder === undefined) return undefined;
	return { ref, folder };
}

/** A flake's folder, as written beside its `#`, or nothing unknown. */
function folderOf(
	written: string,
	cwd: string | undefined,
): string | undefined {
	const folder = written === "" || written === "." ? cwd : written;
	return folder !== undefined && isAbsolute(folder)
		? folder.replace(/\/+$/, "") || "/"
		: undefined;
}

/**
 * `Owner/repo` of a GitHub URL, in either of the forms git writes it:
 * `git@github.com:Owner/repo.git` or `https://github.com/Owner/repo`.
 */
export function githubRepoOf(url: string): string | undefined {
	const match =
		/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
			url.trim(),
		);
	return match?.[1];
}

/**
 * The repositories to send, as `Owner/repo`, from the package config's
 * `remote-checks` section: `{ "repos": ["Owner/repo", ...] }`. None
 * when the section is absent; an error naming the field when it is
 * wrong.
 */
export function parseRemoteChecks(
	value: unknown,
): { ok: true; value: readonly string[] } | { ok: false; error: string } {
	if (value === undefined) return { ok: true, value: [] };
	if (!isRecord(value)) {
		return { ok: false, error: `${REMOTE_CHECKS_SLUG} must be an object` };
	}
	const repos = value.repos ?? [];
	if (
		!Array.isArray(repos) ||
		!repos.every(
			(one) => typeof one === "string" && /^[\w.-]+\/[\w.-]+$/.test(one),
		)
	) {
		return {
			ok: false,
			error: `${REMOTE_CHECKS_SLUG}.repos must be a list of "Owner/repo"`,
		};
	}
	return { ok: true, value: repos };
}

/**
 * What git says of the repository `folder` is in, counting untracked
 * files as changes when `whole`, or nothing when it isn't one or git
 * doesn't answer in time. A build `pin`ned to a commit is of that
 * commit, so it is clean whatever the tree holds, and pushed when a
 * remote branch has it.
 */
export async function repositoryAt(
	folder: string,
	{ whole = false, pin }: { whole?: boolean; pin?: Pin } = {},
): Promise<Repository | undefined> {
	const git = async (cwd: string, ...args: string[]) =>
		(await run("git", args, { cwd, timeout: GIT_MS })).stdout.trim();
	try {
		// A copy just made with `git init` has no commit yet: it is a
		// repository still, as `--show-toplevel` says, with nothing pushed.
		const head = pin
			? await git(pin.folder, "rev-parse", "--verify", `${pin.ref}^{commit}`)
			: await git(folder, "rev-parse", "HEAD").catch(() => "");
		const untracked = whole ? "normal" : "no";
		const [top, status, remotes, origin] = await Promise.all([
			git(folder, "rev-parse", "--show-toplevel"),
			pin
				? Promise.resolve("")
				: git(
						folder,
						"status",
						"--porcelain",
						`--untracked-files=${untracked}`,
					),
			head === ""
				? Promise.resolve("")
				: git(folder, "branch", "-r", "--contains", head),
			// A copy made with `git init` has none, which isn't a failure.
			git(folder, "remote", "get-url", "origin").catch(() => ""),
		]);
		return {
			atTop: realpathSync(top) === realpathSync(folder),
			clean: status === "",
			pushed: remotes !== "",
			head,
			origin,
		};
	} catch {
		// Not a repository, or git too slow: run it as written.
		return undefined;
	}
}

/**
 * The flake the builder fetches for a build of `repository`, as
 * `github:Owner/repo/<rev>`, or nothing when it may not go: the flake
 * isn't the repository's top folder, the tree differs from its pushed
 * commit, or the repository isn't one `repos` names. A private one the
 * builder couldn't fetch, and none named sends nothing.
 */
export function flakeThere(
	repository: Repository,
	repos: readonly string[],
	tree?: string,
): string | undefined {
	if (!repository.atTop) return undefined;
	const repo = githubRepoOf(repository.origin);
	if (!repo) return undefined;
	const named = repos.some((one) => one.toLowerCase() === repo.toLowerCase());
	if (!named) return undefined;
	if (repository.clean && repository.pushed) {
		return `github:${repo}/${repository.head}`;
	}
	// A tree `there` takes as it is: base..HEAD and its changes as a bundle.
	return tree;
}

/**
 * The flake to send for a copy of a tree, as `git archive` and `git init`
 * make one, where `there` takes a folder. QGB4ON built four VM checks
 * that way on optimus on 30 October while it was at load 43.
 *
 * A `path:` build is of the folder as it is, which is what `there` sends
 * for `path:<folder>`, so it goes when no origin is known: a repository
 * with none, one with no commit yet, or no repository. Any other build
 * goes only from the top folder of a repository git says has no origin,
 * as its tracked files; one git didn't answer for may be as big as a
 * monorepo. A repository with an origin is `flakeThere`'s to decide.
 */
export function copyThere(
	repository: Repository | undefined,
	flake: string,
	whole: boolean,
	takes: Takes,
): string | undefined {
	if (!takes.folder || (repository && repository.origin !== "")) {
		return undefined;
	}
	if (whole) return `path:${flake}`;
	return repository?.atTop ? flake : undefined;
}

/**
 * What `nix-offload there` says it takes, asked with `--takes`, or
 * nothing when it is missing, too old to say (64), or slow.
 */
export async function offloadTakes(): Promise<Takes> {
	try {
		const { stdout } = await run("nix-offload", ["there", "--takes"], {
			timeout: GIT_MS,
		});
		const words = new Set(stdout.split(/\s+/));
		return {
			tree: words.has("tree"),
			subtests: words.has("apply") && words.has("out"),
			wants: words.has("wants"),
			folder: words.has("folder"),
		};
	} catch {
		// Not installed, or one that refuses --takes: it takes the commit only.
		return TAKES_NOTHING;
	}
}

/** The `nix-offload there` step building `build` from `flake`. */
export function thereStep(build: CheckBuild, flake: string): string {
	return [
		...build.before,
		"nix-offload there",
		...(build.printLogs ? ["-L"] : []),
		...(build.keepGoing ? ["--keep-going"] : []),
		flake,
		...build.attributes,
		...build.redirections,
	].join(" ");
}

/**
 * `command` with each build sent there in its own step's place, the
 * space around each kept, and a line first on stderr saying so.
 */
export function sentThere(
	command: string,
	sends: readonly { readonly build: CheckBuild; readonly flake: string }[],
	runs: readonly SubtestsRun[] = [],
): string {
	const rewrites = [
		...sends.map(({ build, flake }) => ({
			step: build.step,
			as: thereStep(build, flake),
		})),
		...runs.map((run) => ({
			step: run.step,
			as: subtestsThere(run.step.text),
		})),
	].sort((a, b) => b.step.start - a.step.start);
	let out = command;
	for (const { step, as } of rewrites) {
		const lead = /^\s*/.exec(step.text)?.[0] ?? "";
		const trail = /\s*$/.exec(step.text)?.[0] ?? "";
		out = `${out.slice(0, step.start)}${lead}${as.trim()}${trail}${out.slice(step.end)}`;
	}
	const checks = sends.flatMap(({ build }) => build.attributes).length;
	const what = [
		...(checks > 0 ? [count(checks, "check", "checks")] : []),
		...(runs.length > 0
			? [count(runs.length, "subtests run", "subtests runs")]
			: []),
	].join(" and ");
	const said = `remote-check: ${what} sent to the lent builder from its commit`;
	return `printf '%s\\n' '${said}' >&2; ${out}`;
}

/** A `run-subtests` step, made to have it all built on the builder. */
function subtestsThere(text: string): string {
	return text.replace(/(^|\s)run-subtests(?=\s|$)/, "$1run-subtests --there");
}

/** Whether a builder stands now, by the offload daemon's machines file. */
export function builderStands(kernel: Kernel = KERNEL): boolean {
	if (kernel.machines === undefined) return false;
	try {
		return offloadIn(readFileSync(kernel.machines, "utf8")) !== undefined;
	} catch {
		// No file: no builder stands.
		return false;
	}
}

/**
 * Whether a builder stands, waiting first while one is being lent, up
 * to the queue's {@link LENDING_WAIT_MS} from the lend's start, so a VM
 * check asked for while the builder boots goes to it rather than here.
 */
export async function builderReady(
	kernel: Kernel = KERNEL,
	signal?: AbortSignal,
	now: () => number = Date.now,
	pollMs = LEND_POLL_MS,
): Promise<boolean> {
	for (;;) {
		if (builderStands(kernel)) return true;
		const since = lendingSinceIn(kernel);
		if (since === undefined || now() - since >= LENDING_WAIT_MS) return false;
		if (signal?.aborted) return false;
		await new Promise((done) => setTimeout(done, pollMs));
	}
}
