/**
 * A folder told as the prompt tells it: from the nearest root, whose name
 * leads in text; outside any root, from home as `~`; and outside home, from
 * `/`, which leads muted since it says the least.
 *
 * A root that is a linked worktree is named by its repository rather than
 * by its folder, since a broker names that folder for itself
 * (`worktree-github-owner-repo-branch`) and a person can't read it.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export interface Told {
	/** Written before the first part: `/` for a folder told from the top. */
	readonly lead: string;
	/** The root's name or `~`, the folders between, then the folder itself. */
	readonly parts: readonly string[];
	/** How the first part reads. */
	readonly first: "text" | "muted";
}

/** The nearest folder at or above `dir` holding one of the markers. */
export function rootOf(
	dir: string,
	roots: readonly string[],
	exists: (file: string) => boolean = existsSync,
): string | null {
	let at = dir;
	while (true) {
		for (const marker of roots) {
			if (exists(path.join(at, marker))) return at;
		}
		const up = path.dirname(at);
		if (up === at) return null;
		at = up;
	}
}

function partsOf(relative: string): string[] {
	return relative.split("/").filter((part) => part.length > 0);
}

/** How a file reads, or null when it doesn't. */
export type ReadText = (file: string) => string | null;

function readText(file: string): string | null {
	try {
		return readFileSync(file, "utf8");
	} catch {
		// Not there or not a file: the root keeps its folder's name.
		return null;
	}
}

/** The last part of a remote's address, without `.git`. */
function repoOfUrl(url: string): string | null {
	const last = url.trim().replace(/\/+$/, "").split(/[/:]/).at(-1);
	const name = last?.replace(/\.git$/, "");
	return name ? name : null;
}

/** The url of `origin` in a git config's text. */
function originUrl(config: string): string | null {
	const section = config
		.split(/^\s*\[/m)
		.find((one) => /^remote\s+"origin"\s*\]/.test(one));
	return section?.match(/^\s*url\s*=\s*(.+)$/m)?.[1] ?? null;
}

/**
 * What a person calls the folder `root`: its own name, unless it is a
 * linked worktree, whose `.git` is a file pointing into another
 * repository. That one is named by its `origin`, else by the checkout
 * that holds it, else by its git folder.
 */
export function rootName(root: string, read: ReadText = readText): string {
	const own = path.basename(root);
	const link = read(path.join(root, ".git"))?.match(/^gitdir:\s*(.+)$/m)?.[1];
	if (!link) return own;
	const gitdir = path.resolve(root, link.trim());
	const common = path.resolve(
		gitdir,
		read(path.join(gitdir, "commondir"))?.trim() || ".",
	);
	const config = read(path.join(common, "config"));
	const remote = config ? originUrl(config) : null;
	const named = remote ? repoOfUrl(remote) : null;
	if (named) return named;
	if (path.basename(common) === ".git")
		return path.basename(path.dirname(common));
	return path.basename(common).replace(/\.git$/, "") || own;
}

export function told(
	dir: string,
	roots: readonly string[],
	home: string,
	exists: (file: string) => boolean = existsSync,
	read: ReadText = readText,
): Told {
	const root = rootOf(dir, roots, exists);
	if (root && root !== "/") {
		return {
			lead: "",
			parts: [rootName(root, read), ...partsOf(dir.slice(root.length))],
			first: "text",
		};
	}
	if (home && (dir === home || dir.startsWith(`${home}/`))) {
		return {
			lead: "",
			parts: ["~", ...partsOf(dir.slice(home.length))],
			first: "text",
		};
	}
	return { lead: "/", parts: partsOf(dir), first: "muted" };
}
