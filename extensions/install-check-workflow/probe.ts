/**
 * What the install check reads off disk and out of git.
 *
 * Every read here answers "nothing" rather than throwing: a package
 * installed without git, a manifest somebody trimmed or a git that
 * hangs is a reason to say less, never a reason to fail a session.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	headFromFiles,
	upstreamFromFiles,
} from "../../lib/internal/reload/head.ts";

/** How long one git call may take before it is given up on. */
const GIT_TIMEOUT_MS = 2_000;

/** The `dependencies` a package's manifest asks for. */
export function dependencyRanges(root: string): Record<string, string> {
	try {
		const manifest = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		) as { dependencies?: unknown };
		const deps = manifest.dependencies;
		if (typeof deps !== "object" || deps === null) return {};
		return Object.fromEntries(
			Object.entries(deps).filter(
				(pair): pair is [string, string] => typeof pair[1] === "string",
			),
		);
	} catch {
		// No manifest, or one that does not parse: nothing to check against.
		return {};
	}
}

/**
 * The version of a dependency that resolution from the package would
 * find, walking up `node_modules` the way Node does.
 */
export function installedVersion(
	root: string,
	name: string,
): string | undefined {
	let dir = root;
	for (;;) {
		const manifest = join(dir, "node_modules", name, "package.json");
		if (existsSync(manifest)) {
			try {
				const version = (
					JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }
				).version;
				return typeof version === "string" ? version : undefined;
			} catch {
				// A manifest that does not parse is as good as no version.
				return undefined;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** The command that brings the package's install in line. */
export function installCommand(root: string): string {
	return existsSync(join(root, "pnpm-lock.yaml")) ||
		existsSync(join(root, "node_modules", ".pnpm"))
		? "pnpm install"
		: "npm install --omit=dev";
}

/**
 * Whether the package is its own git checkout, rather than sitting
 * inside somebody else's: a `.git` directory, or the file a worktree
 * has in its place.
 */
export function isCheckout(root: string): boolean {
	return existsSync(join(root, ".git"));
}

function git(
	root: string,
	args: readonly string[],
): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", root, ...args],
			{ timeout: GIT_TIMEOUT_MS },
			(error, stdout) =>
				resolve(error ? undefined : stdout.trim() || undefined),
		);
	});
}

/**
 * The checkout's HEAD commit, or nothing: read from git's files, and
 * asked of git only where they can't say, since forking git from a
 * shared host holds every conversation's loop (OSPHT4, 14 November).
 */
export function headOf(root: string): Promise<string | undefined> {
	if (!isCheckout(root)) return Promise.resolve(undefined);
	const read = headFromFiles(root);
	return read === undefined
		? git(root, ["rev-parse", "HEAD"])
		: Promise.resolve(read);
}

/**
 * Commits the branch's upstream has that HEAD does not, as of the last
 * fetch, or nothing without an upstream. Counting them needs git, so
 * the reader asks it again only once HEAD or the upstream has moved,
 * as their files say; files that can't say ask every time.
 */
export function commitsBehindReader(): (
	root: string,
) => Promise<number | undefined> {
	let counted: { at: string; behind: number | undefined } | undefined;
	return async (root) => {
		if (!isCheckout(root)) return undefined;
		const head = headFromFiles(root);
		const upstream = upstreamFromFiles(root);
		const at = head && upstream ? `${root} ${head} ${upstream}` : undefined;
		if (at !== undefined && counted?.at === at) return counted.behind;
		const said = await git(root, ["rev-list", "--count", "HEAD..@{u}"]);
		const behind = Number.parseInt(said ?? "", 10);
		const answer = Number.isFinite(behind) ? behind : undefined;
		if (at !== undefined) counted = { at, behind: answer };
		return answer;
	};
}
