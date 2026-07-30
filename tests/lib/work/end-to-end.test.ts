/**
 * The working layer against a real git repo.
 *
 * Every other test here uses a fake exec, which proves each piece
 * sends the right argv and nothing about whether the pieces
 * compose. This one cuts a real tree, writes a real file, records
 * it and branches, because that sequence is the whole point of the
 * layer and none of it had ever been run.
 *
 * It costs a handful of subprocesses, so it is one test rather than
 * six, and it uses the shared template so it does not pay for
 * building a repo.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../../lib/review/index.js";
import {
	blocksRepoint,
	createGitAuthor,
	createGitHistory,
	createGitTreeProvider,
	createTreeBroker,
	treeRequestFrom,
} from "../../../lib/work/index.js";
import { disposeRepo, freshRepo } from "../../support/git-fixture.js";

/** Real exec, since the point is that git actually agrees. */
const exec = async (command: string, args: readonly string[]) => {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	try {
		const { stdout, stderr } = await promisify(execFile)(command, [...args]);
		return { code: 0, stdout, stderr };
	} catch (error) {
		const e = error as { code?: number; stdout?: string; stderr?: string };
		return {
			code: e.code ?? 1,
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? "",
		};
	}
};

describe("the working layer, end to end", () => {
	let repo: string;
	let trees: string;

	beforeAll(async () => {
		repo = await freshRepo("work-e2e");
		trees = mkdtempSync(join(tmpdir(), "work-e2e-trees-"));
	});

	afterAll(() => {
		// The worktree has to be forgotten before the repo goes, or git
		// leaves administrative state pointing at a path that is gone.
		try {
			rmSync(trees, { recursive: true, force: true });
		} catch {
			// Best effort: the test's value is what it asserted, not
			// whether the scratch directory came away cleanly.
		}
		disposeRepo(repo);
	});

	it("cuts a tree, records work in it, and moves it onto a branch", async () => {
		const broker = createTreeBroker([
			createGitTreeProvider({ exec, stateDir: trees }),
		]);
		const history = createGitHistory({ exec });
		const author = createGitAuthor({ exec });

		// Not the trunk. Git refuses to check out a branch that is
		// already checked out somewhere, and the source repo has its
		// trunk checked out, so asking for one is a guaranteed failure
		// rather than a test. Making a branch the source repo is not
		// sitting on is what a caller would really do, and it is the
		// reason a worktree is named from its branch alone: git will not
		// give you two trees on one branch anyway.
		const target = "topic/e2e";
		await run(
			exec,
			"git",
			["-C", repo, "branch", target],
			"making a branch to cut from",
		);

		const outcome = treeRequestFrom({
			intent: "worktree",
			repo: { key: "local:work-e2e", localPath: repo },
			purpose: "compose",
			branch: target,
		});
		if ("refusal" in outcome) throw new Error(outcome.refusal);

		const held = await broker.ensure(outcome.request);
		expect(held.providerId).toBe("git-worktree");

		// A fresh tree is clean, and nothing may block re-pointing it.
		const before = await history.status(held.path);
		expect(before.clean).toBe(true);
		expect(blocksRepoint(before)).toBeUndefined();

		// An untracked file is work, which is the case the layer is
		// most insistent about, so it is the one used here.
		writeFileSync(join(held.path, "new.ts"), "export const a = 1;\n");
		const dirty = await history.status(held.path);
		expect(dirty.clean).toBe(false);
		expect(dirty.changed).toEqual([
			{ path: "new.ts", staged: false, kind: "untracked" },
		]);
		expect(blocksRepoint(dirty)).toMatch(/new\.ts/);

		await author.stage(held.path);
		await author.commit(held.path, {
			subject: "feat(a): add a",
			body: "Because the layer had never been run.",
		});

		// Recording it makes the tree clean again and moves HEAD.
		const after = await history.status(held.path);
		expect(after.clean).toBe(true);
		expect(blocksRepoint(after)).toBeUndefined();
		const head = await history.head(held.path);
		expect(head.branch).toBe(target);

		// The body has to have survived as a body rather than as part
		// of the subject, which is the thing two -m flags are for.
		const message = await run(
			exec,
			"git",
			["-C", held.path, "log", "-1", "--pretty=%B"],
			"message",
		);
		expect(message.trim()).toBe(
			"feat(a): add a\n\nBecause the layer had never been run.",
		);

		await author.branch(held.path, "topic/composed");
		expect((await history.head(held.path)).branch).toBe("topic/composed");

		await broker.release(held);
		expect(broker.held()).toEqual([]);
	});
});
