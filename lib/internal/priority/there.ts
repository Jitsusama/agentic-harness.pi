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
 * This module reads a command and the repository it runs in and says
 * what to run instead, or nothing; the interceptor asks git and the
 * builder's files.
 */

import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { promisify } from "node:util";
import { isRecord } from "../record.ts";
import { kindOf, LENDING_WAIT_MS } from "./queue.ts";
import { KERNEL, type Kernel, lendingSinceIn, offloadIn } from "./room.ts";

const run = promisify(execFile);

/** The package config section naming the repositories to send. */
export const REMOTE_CHECKS_SLUG = "remote-checks";

/** How often a call waiting on a lend looks again, in ms. */
export const LEND_POLL_MS = 2_000;

/** How long each git question may take before the command runs as written. */
const GIT_MS = 3_000;

/** A `nix build` of checks that may be sent by commit. */
export interface CheckBuild {
	/** Each check's attribute, as `checks.<system>.<name>`. */
	readonly attributes: readonly string[];
	readonly printLogs: boolean;
	readonly keepGoing: boolean;
	/** The command's own redirections, kept as written. */
	readonly redirections: readonly string[];
}

/** What the repository a command runs in says of itself. */
export interface Repository {
	/** The command runs in the repository's top folder. */
	readonly atTop: boolean;
	/** No tracked file differs from HEAD. */
	readonly clean: boolean;
	/** A remote branch contains HEAD, so the builder can fetch it. */
	readonly pushed: boolean;
	/** HEAD's full commit id. */
	readonly head: string;
	/** Origin's URL. */
	readonly origin: string;
}

/** A word that is a check of the flake in this folder. */
const CHECK = /^(['"]?)\.#(checks\.[\w-]+\.[\w.+-]+)\1$/;

/** Flags that change nothing about what is built or where it lands. */
const PRINT_LOGS = new Set(["-L", "--print-build-logs"]);
const KEEP_GOING = new Set(["--keep-going", "-k"]);

/** A redirection written as one word, as `>$TMPDIR/x.log` or `2>&1`. */
const REDIRECTION = /^(?:\d?>>?|&>>?)\S+$/;

/** A redirection whose target is the next word. */
const REDIRECTS_TO = /^(?:\d?>>?|&>>?)$/;

/**
 * Anything past one plain step: a pipe, a chain, a substitution, a
 * glob, or another line. Its `$` is allowed only in a redirection.
 */
const MORE_THAN_ONE_STEP = /[;|&`()<\n*?]|\$\(/;

/**
 * The checks a command builds, when it is one `nix build --no-link` of
 * checks of the flake in its folder, optionally run under
 * `direnv exec .`, with no flag that changes what is built. Nothing
 * otherwise: a command doing more runs as written.
 */
export function checkBuildOf(command: string): CheckBuild | undefined {
	const words = command.trim().split(/\s+/);
	const plain = words.filter(
		(word, at) =>
			!REDIRECTION.test(word) &&
			!REDIRECTS_TO.test(word) &&
			!REDIRECTS_TO.test(words[at - 1] ?? ""),
	);
	const steps = plain.join(" ");
	if (MORE_THAN_ONE_STEP.test(steps) || steps.includes("$")) return undefined;
	let rest = plain;
	if (rest[0] === "direnv" && rest[1] === "exec" && rest[2] === ".") {
		rest = rest.slice(3);
	}
	if (rest[0] !== "nix" || rest[1] !== "build") return undefined;
	const attributes: string[] = [];
	let noLink = false;
	let printLogs = false;
	let keepGoing = false;
	for (const word of rest.slice(2)) {
		const check = CHECK.exec(word);
		if (check?.[2]) attributes.push(check[2]);
		else if (word === "--no-link") noLink = true;
		else if (PRINT_LOGS.has(word)) printLogs = true;
		else if (KEEP_GOING.has(word)) keepGoing = true;
		else return undefined;
	}
	if (!noLink || attributes.length === 0) return undefined;
	const redirections = words.filter(
		(word, at) =>
			REDIRECTION.test(word) ||
			REDIRECTS_TO.test(word) ||
			REDIRECTS_TO.test(words[at - 1] ?? ""),
	);
	return { attributes, printLogs, keepGoing, redirections };
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
 * The VM checks a command builds and could send, read from it alone, so
 * a command that couldn't go asks git nothing.
 */
export function vmChecksOf(command: string): CheckBuild | undefined {
	return kindOf(command) === "vm-check" ? checkBuildOf(command) : undefined;
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
 * What git says of the repository `cwd` is in, or nothing when it isn't
 * one or git doesn't answer in time.
 */
export async function repositoryAt(
	cwd: string,
): Promise<Repository | undefined> {
	const git = async (...args: string[]) =>
		(await run("git", args, { cwd, timeout: GIT_MS })).stdout.trim();
	try {
		const [top, status, head, remotes, origin] = await Promise.all([
			git("rev-parse", "--show-toplevel"),
			git("status", "--porcelain", "--untracked-files=no"),
			git("rev-parse", "HEAD"),
			git("branch", "-r", "--contains", "HEAD"),
			git("remote", "get-url", "origin"),
		]);
		return {
			atTop: realpathSync(top) === realpathSync(cwd),
			clean: status === "",
			pushed: remotes !== "",
			head,
			origin,
		};
	} catch {
		// Not a repository, no origin, or git too slow: run it as written.
		return undefined;
	}
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

/** The `nix-offload there` command building `build` from `flake`. */
export function thereCommand(build: CheckBuild, flake: string): string {
	return [
		"nix-offload there",
		...(build.printLogs ? ["-L"] : []),
		...(build.keepGoing ? ["--keep-going"] : []),
		flake,
		...build.attributes,
		...build.redirections,
	].join(" ");
}

/**
 * The command to run instead of `command`, sending its VM checks to the
 * builder by commit, or nothing. Only VM checks go: a quick check here
 * takes seconds, where a set of them took about 28 s on the builder.
 * `repos` names the public repositories, as `Owner/repo`; a private one
 * the builder couldn't fetch, and none named sends nothing.
 */
export function sentThere(
	command: string,
	repository: Repository,
	repos: readonly string[],
): string | undefined {
	const build = vmChecksOf(command);
	if (!build) return undefined;
	if (!repository.atTop || !repository.clean || !repository.pushed) {
		return undefined;
	}
	const repo = githubRepoOf(repository.origin);
	if (!repo) return undefined;
	const named = repos.some((one) => one.toLowerCase() === repo.toLowerCase());
	if (!named) return undefined;
	return thereCommand(build, `github:${repo}/${repository.head}`);
}
