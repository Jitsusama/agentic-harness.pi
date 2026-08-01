/**
 * Taking back leaked trees, against real git.
 *
 * Performed rather than faked throughout. The claim that makes this
 * verb allowed to act at all is that removing a worktree leaves the
 * branch alone, and only git can be asked whether that is true.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { reclaimTrees } from "../../../lib/work/reclaim.js";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.js";

const exec = (command: string, args: readonly string[]) =>
	new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
		execFile(command, [...args], (error, stdout, stderr) =>
			done({
				code:
					error === null ? 0 : typeof error.code === "number" ? error.code : 1,
				stdout: stdout ?? "",
				stderr: stderr ?? "",
			}),
		),
	);

let dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) disposeRepo(dir);
	dirs = [];
});

/** A repo with one worktree checked out at its own branch. */
async function repoWithTree(
	name: string,
): Promise<{ local: string; tree: string }> {
	const local = await freshRepo("reclaim");
	dirs.push(local);
	await git(local, "branch", name, "main");
	const tree = `${local}/.wt/${name}`;
	await git(local, "worktree", "add", "-q", tree, name);
	return { local, tree };
}

describe("taking back a tree nothing owns", () => {
	it("removes the directory and leaves the branch behind", async () => {
		const { local, tree } = await repoWithTree("spent");
		// The commit that must survive, so this asks the question that
		// matters rather than only whether a directory went away.
		const before = await git(local, "rev-parse", "spent");

		const outcome = await reclaimTrees({ exec, mainPath: local }, [
			{ path: tree, branch: "spent" },
		]);

		expect(outcome.trees).toEqual([
			{ kind: "reclaimed", path: tree, branch: "spent" },
		]);
		expect(existsSync(tree)).toBe(false);
		// The whole justification for acting here: the work is still named.
		expect(await git(local, "rev-parse", "spent")).toEqual(before);
		expect(await git(local, "worktree", "list")).not.toContain(tree);
	});

	it("carries on past a tree git will not give up", async () => {
		const { local, tree } = await repoWithTree("stuck");
		const second = `${local}/.wt/fine`;
		await git(local, "branch", "fine", "main");
		await git(local, "worktree", "add", "-q", second, "fine");
		// Git refuses a tree with an untracked file in it, which is the
		// realistic obstacle: a build directory nobody committed.
		await writeFile(`${tree}/leftover.txt`, "untracked");

		const outcome = await reclaimTrees({ exec, mainPath: local }, [
			{ path: tree, branch: "stuck" },
			{ path: second, branch: "fine" },
		]);

		// One refusal must not strand the tree behind it.
		expect(outcome.trees[0]?.kind).toBe("refused");
		expect(outcome.trees[1]).toEqual({
			kind: "reclaimed",
			path: second,
			branch: "fine",
		});
		expect(existsSync(tree)).toBe(true);
		expect(existsSync(second)).toBe(false);
	});

	it("says why in git's own words rather than its own", async () => {
		const { local, tree } = await repoWithTree("dirty");
		await writeFile(`${tree}/leftover.txt`, "untracked");

		const outcome = await reclaimTrees({ exec, mainPath: local }, [
			{ path: tree, branch: "dirty" },
		]);

		const refused = outcome.trees[0];
		expect(refused?.kind).toBe("refused");
		// Git says "contains modified or untracked files"; the point is that
		// the reader is told what to go and look at.
		expect(refused?.kind === "refused" && refused.why).toMatch(
			/untracked|modified/,
		);
	});

	it("does nothing at all when nothing was offered", async () => {
		const { local, tree } = await repoWithTree("kept");

		const outcome = await reclaimTrees({ exec, mainPath: local }, []);

		expect(outcome.trees).toEqual([]);
		expect(existsSync(tree)).toBe(true);
	});
});
