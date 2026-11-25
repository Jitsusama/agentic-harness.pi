/**
 * The sweep's memory of what git's status said of each tree: a tree
 * unchanged since the last sweep is answered from it, and any change a
 * status could show asks git again.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** One sweep: ask `path`'s status through a fresh memory, and save it. */
async function sweep(exec: Exec, path = tree, now = 1_000_000) {
	const memory = rememberStatuses(
		exec,
		join(state, "sweep-status.json"),
		() => now,
	);
	const args = [...STATUS];
	args[1] = path;
	const answer = await memory.exec("git", args);
	memory.save();
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
		const { ran, exec } = counting({ code: 128, stdout: "", stderr: "lock" });

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
