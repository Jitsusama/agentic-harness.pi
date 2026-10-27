/**
 * Resuming a halted replay once its conflicts are settled in the files.
 *
 * The work tools have no way to stage, so "settle these, then resume" left
 * a step only raw git could take: a file edited clean but never added was
 * still unmerged, and resume reported the same halt again. An agent that
 * did not know to `git add` went round that loop and then left the tool
 * for raw git. So resume stages what is plainly settled, and only that: a
 * text file both sides changed, with no conflict marker left in it. Run
 * against real git, since what counts as unmerged is git's to say.
 *
 * A resumed halt also has to say what the replay is onto, which git keeps
 * only as a commit. Named after whichever branch sat on that commit, a
 * replay onto origin/main was once reported as onto a merged branch left
 * there, and the agent stopped to work out which base was real.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { spawnExec } from "../../../lib/core/exec/index.ts";
import { createGitRebaser } from "../../../lib/core/work/rebase.ts";
import {
	disposeRepo,
	freshRepo,
	git,
	REAL_GIT_MS,
} from "../../support/git-fixture.ts";

let repo: string;

beforeEach(async () => {
	repo = await freshRepo("rebase-settle");
});

afterEach(() => {
	disposeRepo(repo);
});

/** Commit these files, as they are given, on the branch checked out. */
async function commit(
	files: Record<string, string | Buffer | null>,
	message: string,
): Promise<void> {
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(repo, name)), { recursive: true });
		if (content === null) await git(repo, "rm", "-q", name);
		else {
			writeFileSync(join(repo, name), content);
			await git(repo, "add", name);
		}
	}
	await git(repo, "commit", "-qm", message);
}

/**
 * `topic` and `main` each changing what the base had, so replaying topic
 * onto main halts. Returns the halt.
 */
async function halted(
	base: Record<string, string | Buffer>,
	onMain: Record<string, string | Buffer | null>,
	onTopic: Record<string, string | Buffer | null>[],
	onto = "main",
	before: () => Promise<void> = async () => {},
) {
	await commit(base, "base");
	await git(repo, "checkout", "-q", "-b", "topic");
	for (const [index, files] of onTopic.entries()) {
		await commit(files, `topic ${index + 1}`);
	}
	await git(repo, "checkout", "-q", "main");
	await commit(onMain, "main moves");
	await git(repo, "checkout", "-q", "topic");
	await before();
	const outcome = await rebaser().rebase(repo, onto);
	expect(outcome.kind).toBe("halted");
	return outcome;
}

function rebaser() {
	return createGitRebaser({ exec: spawnExec() });
}

async function unmerged(): Promise<string> {
	return git(repo, "diff", "--name-only", "--diff-filter=U");
}

describe("resuming once a conflict is settled in the file", {
	timeout: REAL_GIT_MS,
}, () => {
	it("stages the settled file and carries on, without a git add", async () => {
		await halted({ "notes.md": "a\n" }, { "notes.md": "main\n" }, [
			{ "notes.md": "topic\n" },
		]);
		// A setext heading underline is not a conflict marker.
		writeFileSync(join(repo, "notes.md"), "Notes\n=======\nmain, topic\n");

		const outcome = await rebaser().resume(repo);

		expect(outcome).toEqual({ kind: "replayed", branch: "topic" });
		expect(await git(repo, "show", "HEAD:notes.md")).toBe(
			"Notes\n=======\nmain, topic",
		);
	});

	it("stages it from a directory inside the tree, as a World tree's is", async () => {
		await halted(
			{ "src/keep.md": "keep\n", "notes.md": "a\n" },
			{ "notes.md": "main\n" },
			[{ "notes.md": "topic\n" }],
		);
		writeFileSync(join(repo, "notes.md"), "main, topic\n");

		const outcome = await rebaser().resume(join(repo, "src"));

		expect(outcome).toEqual({ kind: "replayed", branch: "topic" });
	});

	it("halts again at the next commit that conflicts, naming that commit", async () => {
		const first = await halted(
			{ "notes.md": "a\n" },
			{ "notes.md": "main\n" },
			[{ "notes.md": "topic 1\n" }, { "notes.md": "topic 2\n" }],
		);
		writeFileSync(join(repo, "notes.md"), "main, topic 1\n");

		const outcome = await rebaser().resume(repo);

		expect(outcome).toMatchObject({
			kind: "halted",
			conflicted: ["notes.md"],
		});
		expect(outcome.kind === "halted" && outcome.at).not.toBe(
			first.kind === "halted" && first.at,
		);
	});
});

describe("leaving unsettled what is not plainly settled", {
	timeout: REAL_GIT_MS,
}, () => {
	it("keeps a file that still holds conflict markers unmerged", async () => {
		await halted({ "notes.md": "a\n" }, { "notes.md": "main\n" }, [
			{ "notes.md": "topic\n" },
		]);

		const outcome = await rebaser().resume(repo);

		expect(outcome).toMatchObject({ kind: "halted", conflicted: ["notes.md"] });
		expect(await unmerged()).toBe("notes.md");
		expect(readFileSync(join(repo, "notes.md"), "utf8")).toContain("<<<<<<<");
	});

	it("keeps a file one side deleted unmerged, since git wrote no markers to remove", async () => {
		await halted({ "notes.md": "a\n" }, { "notes.md": null }, [
			{ "notes.md": "topic\n" },
		]);

		const outcome = await rebaser().resume(repo);

		expect(outcome).toMatchObject({ kind: "halted", conflicted: ["notes.md"] });
		expect(await unmerged()).toBe("notes.md");
	});

	it("keeps a binary file unmerged, since git wrote no markers into it", async () => {
		const bytes = (fill: number) => Buffer.from([0, fill, 0, fill]);
		await halted({ "blob.bin": bytes(1) }, { "blob.bin": bytes(2) }, [
			{ "blob.bin": bytes(3) },
		]);

		const outcome = await rebaser().resume(repo);

		expect(outcome).toMatchObject({ kind: "halted", conflicted: ["blob.bin"] });
		expect(await unmerged()).toBe("blob.bin");
	});

	it("stages the settled file and names the one still to settle", async () => {
		await halted(
			{ "notes.md": "a\n", "other.md": "a\n" },
			{ "notes.md": "main\n", "other.md": "main\n" },
			[{ "notes.md": "topic\n", "other.md": "topic\n" }],
		);
		writeFileSync(join(repo, "notes.md"), "main, topic\n");

		const outcome = await rebaser().resume(repo);

		expect(outcome).toMatchObject({ kind: "halted", conflicted: ["other.md"] });
		expect(await unmerged()).toBe("other.md");
	});

	it("leaves a file removed from the tree to be settled by hand", async () => {
		await halted({ "notes.md": "a\n" }, { "notes.md": "main\n" }, [
			{ "notes.md": "topic\n" },
		]);
		rmSync(join(repo, "notes.md"));

		const outcome = await rebaser().resume(repo);

		expect(outcome).toMatchObject({ kind: "halted", conflicted: ["notes.md"] });
	});
});

describe("naming what a resumed replay is onto", {
	timeout: REAL_GIT_MS,
}, () => {
	/**
	 * Trunk only as a remote's, with a merged branch left on the same commit,
	 * as the tree was on 20 October.
	 */
	async function remoteTrunk(): Promise<void> {
		await git(repo, "update-ref", "refs/remotes/origin/main", "main");
		await git(repo, "branch", "merged", "main");
		await git(repo, "branch", "-q", "-D", "main");
	}

	it("names the ref it was started onto, not a branch on the same commit", async () => {
		await halted(
			{ "notes.md": "a\n" },
			{ "notes.md": "main\n" },
			[{ "notes.md": "topic\n" }],
			"origin/main",
			remoteTrunk,
		);

		const outcome = await rebaser().resume(repo);

		expect(outcome).toMatchObject({ kind: "halted", onto: "origin/main" });
	});

	it("leaves nothing of the name behind once the replay ends, either way", async () => {
		const three = () =>
			halted({ "notes.md": "a\n" }, { "notes.md": "main\n" }, [
				{ "notes.md": "topic\n" },
			]);
		await three();
		writeFileSync(join(repo, "notes.md"), "main, topic\n");
		expect(await rebaser().resume(repo)).toMatchObject({ kind: "replayed" });
		expect(await rebaser().halted(repo)).toBe(false);

		// Again from the start, this time abandoned.
		disposeRepo(repo);
		repo = await freshRepo("rebase-settle");
		await three();
		expect(await rebaser().abandon(repo)).toMatchObject({ kind: "abandoned" });
		expect(await rebaser().halted(repo)).toBe(false);
	});

	it("says which commit that was, once the ref has moved on", async () => {
		await halted(
			{ "notes.md": "a\n" },
			{ "notes.md": "main\n" },
			[{ "notes.md": "topic\n" }],
			"origin/main",
			remoteTrunk,
		);
		const onto = await git(repo, "rev-parse", "--short=8", "merged");
		await git(repo, "update-ref", "refs/remotes/origin/main", "merged~1");

		const outcome = await rebaser().resume(repo);

		expect(outcome).toMatchObject({
			kind: "halted",
			onto: `origin/main at ${onto}`,
		});
	});
});
