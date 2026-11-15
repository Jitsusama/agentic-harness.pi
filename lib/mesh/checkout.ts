/**
 * Which checkout a folder sits in and what its repository is called,
 * read from the disk without running git, since a presence and a lease
 * ask often. Both are facts of the disk, kept by the folder that asked.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

/** Checkouts found for a folder, by the folder; they rarely change. */
const checkouts = new Map<string, string | undefined>();

/**
 * The checkout a folder is in, found by looking up for a `.git`, and
 * never the home directory's, which says nothing about the work.
 */
export function checkoutOf(cwd: string): string | undefined {
	if (checkouts.has(cwd)) return checkouts.get(cwd);
	let found: string | undefined;
	for (let at = cwd; at !== homedir(); at = dirname(at)) {
		if (existsSync(join(at, ".git"))) {
			found = at;
			break;
		}
		if (dirname(at) === at) break;
	}
	checkouts.set(cwd, found);
	return found;
}

/** Repository names already read, by checkout; they never change. */
const repositories = new Map<string, string>();

/**
 * The name of the repository checked out here, as people write it
 * (agentic-harness.pi), rather than the folder it sits in, which for a
 * worktree is a name only the tree broker uses. Read from the origin
 * remote in git's own config, without running git, since presence is
 * worked out often; the folder's name when there is no such remote.
 */
export function repositoryName(checkout: string): string {
	const known = repositories.get(checkout);
	if (known !== undefined) return known;
	const name = originName(checkout) ?? basename(checkout);
	repositories.set(checkout, name);
	return name;
}

function originName(checkout: string): string | undefined {
	try {
		const config = readFileSync(join(commonGitDir(checkout), "config"), "utf8");
		const origin = config
			.split(/^\[/m)
			.find((section) => section.startsWith('remote "origin"]'));
		const url = origin?.match(/^\s*url\s*=\s*(\S+)\s*$/m)?.[1];
		const name = url
			?.replace(/\/+$/, "")
			.split(/[/:]/)
			.pop()
			?.replace(/\.git$/, "");
		return name && name.length > 0 ? name : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The git directory a checkout shares with its siblings: its own `.git`
 * folder, or for a worktree the one its `.git` file points through.
 */
function commonGitDir(checkout: string): string {
	const dotGit = join(checkout, ".git");
	let pointer: string;
	try {
		pointer = readFileSync(dotGit, "utf8");
	} catch {
		return dotGit;
	}
	const gitDir = pointer.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
	if (!gitDir) return dotGit;
	const own = isAbsolute(gitDir) ? gitDir : join(checkout, gitDir);
	try {
		const common = readFileSync(join(own, "commondir"), "utf8").trim();
		return isAbsolute(common) ? common : join(own, common);
	} catch {
		return dirname(dirname(own));
	}
}
