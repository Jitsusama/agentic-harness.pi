/**
 * Where a path's work lives, and whether a tree has changed.
 *
 * Verification ran in the directory the session started in, which is
 * not where the work is when it happens in a worktree. These answer
 * which repository a path belongs to, and give a tree a fingerprint so
 * a check run's verdict is only trusted while the tree is the one it
 * judged.
 *
 * Git is asked off the thread: a host runs many conversations on one
 * thread, and a git status over a large tree, or one waiting on a lock,
 * held every one of them for as long as it took. The guard in front of
 * each ask (tree-git.ts) still finds the repository synchronously, a
 * few stats up the folder's parents, which a stalled mount would hold
 * as git once did.
 */

import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
	EXIT_ABORTED,
	EXIT_SAID_TOO_MUCH,
	EXIT_TIMED_OUT,
	spawnExec,
} from "../../lib/core/exec/index.ts";
import { gitRules } from "../../lib/internal/sandbox/sandbox.ts";
import {
	GIT_REFUSED,
	guardedExec,
	refusedIn,
} from "../../lib/internal/sandbox/tree-git.ts";

/** How long one git question may take before it counts as unanswered. */
const GIT_WALL_MS = 5_000;

/**
 * The most a status may print before it counts as unanswered: a tree
 * changed this widely is fingerprinted by no list a commit should wait
 * to read, nor hold in memory.
 */
const STATUS_MOST_CHARS = 1024 * 1024;

/** How many changed files are stamped at once. */
const STAMPED_AT_ONCE = 64;

/**
 * Whether `path` is still on disk, asked off the thread: only a path
 * the disk says isn't there is gone, and one out of reach for now is
 * taken as there.
 */
export async function present(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		const code = error instanceof Error && Reflect.get(error, "code");
		return code !== "ENOENT" && code !== "ENOTDIR";
	}
}

/** The directory a path names: itself when a directory, else its parent. */
export function directoryOf(path: string): string {
	const absolute = resolve(path);
	try {
		if (statSync(absolute).isDirectory()) return absolute;
	} catch {
		// Missing: a file about to be written, so its parent is the place.
	}
	return dirname(absolute);
}

/**
 * The top of the git repository holding dir, or undefined outside one
 * or when git gives no answer. A git the guard refused never ran, but
 * the guard found the repository it refused, so that is the answer.
 */
export async function gitRoot(
	dir: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const asked = await ask(dir, ["rev-parse", "--show-toplevel"], signal);
	if (!asked.answered) return undefined;
	if (asked.code === 0) return asked.stdout.trim() || undefined;
	return asked.code === GIT_REFUSED ? refusedIn(dir, gitRules()) : undefined;
}

/** Whether path is root or lies inside it, with links resolved. */
export function within(root: string, path: string): boolean {
	const r = canonical(root);
	const p = canonical(path);
	return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * A fingerprint of what the tree at `root` holds: what the commit it
 * sits on holds there, and the size and modification time of every
 * file under it that differs, untracked ones included. Only `root` is
 * read, so work elsewhere in its repository, such as another project's,
 * leaves it alone; staging does too, since it moves no file. Undefined
 * outside git, when git does not answer in time or says too much, or
 * once `signal` fires. A folder no commit holds yet is told by git
 * saying so, never by git saying nothing.
 */
export async function treeFingerprint(
	root: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	// Takes no lock, so it never stands in the way of the session's own git.
	const status = [
		"--no-optional-locks",
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
		"--",
		".",
	];
	const [head, changed, top] = await Promise.all([
		ask(root, ["rev-parse", "HEAD:./"], signal),
		git(root, status, signal, STATUS_MOST_CHARS),
		ask(root, ["rev-parse", "--show-toplevel"], signal),
	]);
	const topDir = top.answered && top.code === 0 ? top.stdout.trim() : "";
	if (!head.answered || changed === undefined || !topDir) return undefined;
	const uncommitted = saysFatally(head, NO_COMMIT);
	// Any other failure says nothing of what the tree sits on.
	if (head.code !== 0 && !uncommitted) return undefined;
	const commit = uncommitted ? undefined : head.stdout;
	const print = await fingerprintOf(commit, changed, topDir);
	// Stopped while stamping: what it read is no answer.
	return signal?.aborted ? undefined : print;
}

/**
 * Whether git itself ended `asked` saying `message`: its own fatal exit
 * and line, so a refusal quoting a path that holds the words isn't it.
 */
function saysFatally(asked: Asked, message: RegExp): boolean {
	return (
		asked.answered && asked.code === GIT_FATAL && message.test(asked.stderr)
	);
}

/** The code git exits with when it can't do what it was asked. */
const GIT_FATAL = 128;

/**
 * What git says, in the C locale, of a folder no commit holds yet: a
 * HEAD with no commit, or one whose commit has nothing there.
 */
const NO_COMMIT =
	/^fatal: (.*(unknown revision|ambiguous argument)|invalid object name 'HEAD'|path '.*' exists on disk, but not in 'HEAD')/m;

/** Git's messages untranslated, so what it says can be told apart. */
const UNTRANSLATED = { LC_ALL: "C" };

/** The fingerprint of a tree at `head` whose status said `status`. */
async function fingerprintOf(
	head: string | undefined,
	status: string,
	top: string,
): Promise<string> {
	const paths = changedPaths(status);
	const files: string[] = [];
	// A few at a time, so a wide change doesn't open every file at once.
	for (let at = 0; at < paths.length; at += STAMPED_AT_ONCE) {
		const batch = paths.slice(at, at + STAMPED_AT_ONCE);
		files.push(...(await Promise.all(batch.map((p) => stamped(top, p)))));
	}
	return createHash("sha1")
		.update((head ?? "no-commit").trim())
		.update("\n")
		.update(files.sort().join("\n"))
		.digest("hex");
}

/** A changed path with its size and modification time, or as gone. */
async function stamped(top: string, path: string): Promise<string> {
	try {
		const s = await lstat(join(top, path));
		return `${path}\t${s.size}\t${s.mtimeMs}`;
	} catch {
		// Deleted, or gone since git named it: its absence is what changed.
		return `${path}\tgone`;
	}
}

/** The paths `git status --porcelain -z` names, renames' sources aside. */
function changedPaths(status: string): string[] {
	const tokens = status.split("\0").filter((t) => t.length > 0);
	const paths: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const entry = tokens[i] ?? "";
		paths.push(entry.slice(3));
		// A rename or copy carries its source as the next token.
		if (entry[0] === "R" || entry[0] === "C") i++;
	}
	return paths;
}

function canonical(path: string): string {
	const absolute = resolve(path);
	if (existsSync(absolute)) return realpathSync(absolute);
	// Not there yet: resolve the part that is, so a link above it still
	// compares equal to the same directory reached the long way.
	const parent = dirname(absolute);
	if (parent === absolute) return absolute;
	return join(canonical(parent), absolute.slice(parent.length + 1));
}

/**
 * What git prints for `args` in `cwd`, or undefined when it gives no
 * answer. It runs as every unattended command does (`spawnExec`): unable
 * to prompt, and stopped with all it started by its clock, `signal`, or
 * printing more than `mostChars`.
 */
async function git(
	cwd: string,
	args: readonly string[],
	signal?: AbortSignal,
	mostChars?: number,
): Promise<string | undefined> {
	const asked = await ask(cwd, args, signal, mostChars);
	// Not a repository, git missing or refused, stopped, or out of time.
	return asked.answered && asked.code === 0 ? asked.stdout : undefined;
}

/** What git said and how it ended, or that it gave no answer. */
type Asked = Answered | { readonly answered: false };

/** What a git that ran to its end said. */
interface Answered {
	readonly answered: true;
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** The exit codes of a git stopped before it answered. */
const UNANSWERED: ReadonlySet<number> = new Set([
	EXIT_TIMED_OUT,
	EXIT_ABORTED,
	EXIT_SAID_TOO_MUCH,
]);

/**
 * Ask git `args` in `cwd`, telling an answer, a refusal or a "no"
 * included, from none: git stopped by its clock, `signal` or saying
 * more than `mostChars`.
 */
async function ask(
	cwd: string,
	args: readonly string[],
	signal?: AbortSignal,
	mostChars?: number,
): Promise<Asked> {
	const bounds = {
		cwd,
		timeoutMs: GIT_WALL_MS,
		env: UNTRANSLATED,
		...(signal ? { signal } : {}),
		...(mostChars ? { maxOutputChars: mostChars } : {}),
	};
	// Outside any sandbox, so held to where a sandboxed command couldn't
	// have set what git runs (tree-git.ts).
	const exec = guardedExec(spawnExec(bounds), gitRules, cwd);
	let said: Awaited<ReturnType<typeof exec>>;
	try {
		said = await exec("git", [...args]);
	} catch {
		// A spawn that threw (out of descriptors, say) is no answer, so a
		// commit's check and a turn's end go on rather than reject.
		return { answered: false };
	}
	const { code, stdout, stderr } = said;
	if (UNANSWERED.has(code) || signal?.aborted) return { answered: false };
	return { answered: true, code, stdout, stderr };
}
