/**
 * A tree's uncommitted changes as a patch, so work taken over on another
 * machine loses nothing that was never committed.
 *
 * `work carry` leaves such files behind and names them, which suits a
 * machine leaving for good whose person records them first. A takeover
 * moves a session mid-work instead, so its changes go too: every one,
 * untracked files included and ignored ones left out, as git sees them.
 *
 * The tree's own index and files are never touched. A copy of its index
 * takes `git add -A` (a copy rather than a fresh one, so git hashes only
 * what changed), and git writes the diff of that copy against HEAD
 * straight to a file, binary changes and all, since a string would mangle
 * a file that isn't UTF-8. The file is written in the folder's
 * `.writing` and renamed into place, so it is there whole or not at all.
 */

import { randomBytes } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Exec } from "../../core/exec/index.ts";
import { WRITING } from "../write-whole.ts";

/** What patching a tree's changes did. */
export type Patched =
	| { readonly kind: "clean" }
	| { readonly kind: "patched"; readonly patch: string }
	| { readonly kind: "refused"; readonly reason: string };

/**
 * Writes the uncommitted changes of the tree at `treePath` into `into`
 * as `<name>.patch`, or nothing when it is clean.
 */
export async function patchChanges(
	exec: Exec,
	treePath: string,
	into: string,
	name: string,
): Promise<Patched> {
	const scratch = mkdtempSync(join(tmpdir(), "pi-carry-index-"));
	// Named by chance rather than by pid: a host runs every conversation
	// in one process, and two taking over at once must not share a file.
	const staged = join(
		into,
		WRITING,
		`${name}.patch.${randomBytes(4).toString("hex")}`,
	);
	try {
		const index = join(scratch, "index");
		await copyIndex(exec, treePath, index);
		const git = (args: readonly string[]) =>
			exec("env", [`GIT_INDEX_FILE=${index}`, "git", "-C", treePath, ...args]);
		const added = await git(["add", "-A"]);
		if (added.code !== 0) return refused("take its changes", added.stderr);
		mkdirSync(join(into, WRITING), { recursive: true });
		const diffed = await git([
			"diff",
			"--cached",
			"--binary",
			"--no-color",
			"--no-ext-diff",
			`--output=${staged}`,
			"HEAD",
		]);
		if (diffed.code !== 0) return refused("write its changes", diffed.stderr);
		if (statSync(staged).size === 0) return { kind: "clean" };
		const patch = `${name}.patch`;
		renameSync(staged, join(into, patch));
		return { kind: "patched", patch };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
		rmSync(staged, { force: true });
	}
}

/**
 * Copies the tree's index to `to`, so adding to the copy hashes only what
 * changed; a tree with no index yet leaves nothing, which git starts from.
 */
async function copyIndex(
	exec: Exec,
	treePath: string,
	to: string,
): Promise<void> {
	const said = await exec("git", [
		"-C",
		treePath,
		"rev-parse",
		"--git-path",
		"index",
	]);
	if (said.code !== 0) return;
	try {
		copyFileSync(resolve(treePath, said.stdout.trim()), to);
	} catch {
		// No index yet: git builds the copy from nothing, hashing every file.
	}
}

function refused(what: string, stderr: string): Patched {
	return { kind: "refused", reason: `git couldn't ${what}: ${stderr.trim()}` };
}
