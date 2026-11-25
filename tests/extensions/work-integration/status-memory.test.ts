/**
 * The sweep's memory of what git's status said of each tree: a dirty
 * tree whose HEAD, branch, index and top folder are unchanged since the
 * last sweep is answered from it, and a change to any of those asks git
 * again. A change below the top folder goes unseen, so a clean answer is
 * never served.
 */

import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	rememberStatuses,
	STATUS_REMEMBERED_MS,
} from "../../../extensions/work-integration/status-memory.ts";
import type { Exec } from "../../../lib/core/exec/index.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

let main: string;
let state: string;
let tree: string;

beforeEach(async () => {
	main = await freshRepo("status-memory");
	state = mkdtempSync(join(tmpdir(), "status-memory-state-"));
	tree = join(state, "tree");
	await git(main, "worktree", "add", "-q", "-b", "topic", tree);
});

afterEach(() => {
	disposeRepo(main);
	rmSync(state, { recursive: true, force: true });
});

/** A stand-in git that answers every status with `said`, counting each it ran. */
function counting(said = { code: 0, stdout: " M notes.txt\n", stderr: "" }) {
	const ran: string[][] = [];
	const exec: Exec = async (command, args) => {
		ran.push([command, ...args]);
		return said;
	};
	return { ran, exec };
}

const STATUS = ["-C", "", "--no-optional-locks", "status", "--porcelain=v1"];

/**
 * One sweep: ask `path`'s status through a fresh memory, and save it,
 * forgetting the `refused`.
 */
async function sweep(
	exec: Exec,
	path = tree,
	now = 1_000_000,
	{ flags = [] as string[], refused = [] as string[] } = {},
) {
	const memory = rememberStatuses(
		exec,
		join(state, "sweep-status.json"),
		() => now,
	);
	const args = [...STATUS, ...flags];
	args[1] = path;
	const answer = await memory.exec("git", args);
	memory.save(refused);
	return answer;
}

describe("the sweep's memory of trees' statuses", () => {
	it("answers a tree unchanged since the last sweep with what git said then", async () => {
		const { ran, exec } = counting();

		await sweep(exec);
		const second = await sweep(exec);

		expect(ran.length, "statuses git ran").toBe(1);
		expect(second, "the remembered answer").toEqual({
			code: 0,
			stdout: " M notes.txt\n",
			stderr: "",
		});
	});

	it("asks again once the tree's branch has moved", async () => {
		const { ran, exec } = counting();
		await sweep(exec);

		await git(tree, "commit", "-q", "--allow-empty", "-m", "more");
		await sweep(exec);

		expect(ran.length, "statuses git ran").toBe(2);
	});

	it("asks again once the tree's index has changed", async () => {
		const { ran, exec } = counting();
		writeFileSync(join(tree, "notes.txt"), "kept\n");
		await sweep(exec);

		await git(tree, "add", "notes.txt");
		await sweep(exec);

		expect(ran.length, "statuses git ran").toBe(2);
	});

	it("asks again once a detached tree's HEAD has moved", async () => {
		const { ran, exec } = counting();
		const snapshot = join(state, "snapshot");
		await git(main, "worktree", "add", "-q", "--detach", snapshot);
		await sweep(exec, snapshot);

		await git(snapshot, "commit", "-q", "--allow-empty", "-m", "more");
		await sweep(exec, snapshot);

		expect(ran.length, "statuses git ran").toBe(2);
	});

	it("never answers from memory that a tree is clean", async () => {
		const { ran, exec } = counting({ code: 0, stdout: "", stderr: "" });

		await sweep(exec);
		await sweep(exec);

		expect(ran.length, "statuses git ran").toBe(2);
	});

	it("never serves a clean answer an earlier build left in the file", async () => {
		const { ran, exec } = counting();
		await sweep(exec);
		const file = join(state, "sweep-status.json");
		const saved: Record<string, { stdout: string }> = JSON.parse(
			readFileSync(file, "utf8"),
		);
		for (const one of Object.values(saved)) one.stdout = "";
		writeFileSync(file, JSON.stringify(saved));

		await sweep(exec);

		expect(ran.length, "statuses git ran").toBe(2);
	});

	it("asks git when HEAD's ref climbs out of refs/ through ..", async () => {
		const { ran, exec } = counting();
		const gitDir = (await git(tree, "rev-parse", "--absolute-git-dir")).trim();
		writeFileSync(join(gitDir, "HEAD"), "ref: refs/../../../../elsewhere\n");

		await sweep(exec);
		await sweep(exec);

		expect(ran.length, "statuses git ran").toBe(2);
	});

	it("asks git when the branch's ref is a link", async () => {
		const { ran, exec } = counting();
		const common = (await git(main, "rev-parse", "--absolute-git-dir")).trim();
		const ref = join(common, "refs", "heads", "topic");
		const moved = join(state, "ref-elsewhere");
		writeFileSync(moved, readFileSync(ref));
		rmSync(ref);
		symlinkSync(moved, ref);

		await sweep(exec);
		await sweep(exec);

		expect(ran.length, "statuses git ran").toBe(2);
	});

	it("asks git when HEAD names a ref outside refs/", async () => {
		const { ran, exec } = counting();
		const gitDir = (await git(tree, "rev-parse", "--absolute-git-dir")).trim();
		writeFileSync(join(gitDir, "HEAD"), "ref: ../../../../elsewhere\n");

		await sweep(exec);
		await sweep(exec);

		expect(ran.length, "statuses git ran").toBe(2);
	});

	it("asks git when the tree's index is a link", async () => {
		const { ran, exec } = counting();
		const gitDir = (await git(tree, "rev-parse", "--absolute-git-dir")).trim();
		const index = join(gitDir, "index");
		const moved = join(state, "index-elsewhere");
		writeFileSync(moved, readFileSync(index));
		rmSync(index);
		symlinkSync(moved, index);

		await sweep(exec);
		await sweep(exec);

		expect(ran.length, "statuses git ran").toBe(2);
	});

	it("asks git when commondir names a folder git wouldn't", async () => {
		const { ran, exec } = counting();
		const gitDir = (await git(tree, "rev-parse", "--absolute-git-dir")).trim();
		writeFileSync(join(gitDir, "commondir"), `${state}\n`);

		await sweep(exec);
		await sweep(exec);

		expect(ran.length, "statuses git ran").toBe(2);
	});

	it("asks again of a tree whose take was refused", async () => {
		const { ran, exec } = counting();
		await sweep(exec, tree, 1_000_000, { refused: [tree] });

		await sweep(exec);

		expect(ran.length, "statuses git ran").toBe(2);
	});

	it("asks again when the status asked is another", async () => {
		const { ran, exec } = counting();
		await sweep(exec);

		await sweep(exec, tree, 1_000_000, { flags: ["--ignored=matching"] });

		expect(ran.length, "statuses git ran").toBe(2);
	});

	it("asks git, never reading through it, when the tree's .git is a pipe", async () => {
		const { ran, exec } = counting();
		rmSync(join(tree, ".git"));
		execFileSync("mkfifo", [join(tree, ".git")]);

		await sweep(exec);
		await sweep(exec);

		expect(ran.length, "statuses git ran").toBe(2);
	});

	it("doesn't see a file added below the top folder, which the take asks git of", async () => {
		const { ran, exec } = counting();
		mkdirSync(join(tree, "sub"));
		await sweep(exec);

		writeFileSync(join(tree, "sub", "new.txt"), "fresh\n");
		await sweep(exec);

		expect(ran.length, "statuses git ran").toBe(1);
	});

	it("asks again once a file appears in the tree's own folder", async () => {
		const { ran, exec } = counting();
		await sweep(exec);

		writeFileSync(join(tree, "new.txt"), "fresh\n");
		await sweep(exec);

		expect(ran.length, "statuses git ran").toBe(2);
	});

	it("asks again once its answer is a day old", async () => {
		const { ran, exec } = counting();
		await sweep(exec, tree, 1_000_000);

		await sweep(exec, tree, 1_000_000 + STATUS_REMEMBERED_MS);

		expect(ran.length, "statuses git ran").toBe(2);
	});

	it("never remembers a status that failed", async () => {
		// It printed part of an answer before failing, so only the failure
		// keeps it out of memory.
		const { ran, exec } = counting({
			code: 128,
			stdout: " M notes.txt\n",
			stderr: "lock",
		});

		await sweep(exec);
		await sweep(exec);

		expect(ran.length, "statuses git ran").toBe(2);
	});

	it("forgets a tree the last sweep didn't ask of", async () => {
		const { ran, exec } = counting();
		const other = join(state, "other");
		await git(main, "worktree", "add", "-q", "-b", "other", other);
		await sweep(exec, tree);
		await sweep(exec, other);

		await sweep(exec, tree);

		expect(ran.length, "statuses git ran").toBe(3);
	});

	it("runs every other command as it is", async () => {
		const { ran, exec } = counting();
		const memory = rememberStatuses(exec, join(state, "sweep-status.json"));

		await memory.exec("git", ["-C", tree, "rev-parse", "HEAD"]);
		await memory.exec("git", ["-C", tree, "rev-parse", "HEAD"]);

		expect(ran.length, "commands run").toBe(2);
	});
});
