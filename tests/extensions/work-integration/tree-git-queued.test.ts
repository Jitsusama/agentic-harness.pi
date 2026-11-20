/**
 * The work tool's git is held to the folders it may run in before the
 * machine's queue takes it.
 *
 * The queue runs a heavy git as a `bash -c` line, which the guard lets
 * by as no git of its own, so a guard behind the queue never read a
 * queued push. A sandboxed command could then point a World tree's
 * `.git` at a folder of its own and have the push run its settings and
 * hooks outside the sandbox.
 */

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { treeExecOver } from "../../../extensions/work-integration/broker.ts";
import type { Exec } from "../../../lib/core/exec/index.ts";
import { queueFolder } from "../../../lib/internal/priority/folder.ts";
import { queueHeavyWork } from "../../../lib/internal/priority/turn.ts";

let root: string;
let jobs: string;
let tree: string;
let undo: (() => void) | undefined;
let savedHome: string | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "tree-git-queued-"));
	// The queue reads World's trees from home, so home is here.
	savedHome = process.env.HOME;
	process.env.HOME = root;
	jobs = join(root, "jobs");
	mkdirSync(jobs);
	writeFileSync(join(jobs, "queue.json"), "{}\n");
	// Named as World's trees are, so the queue takes a push of it.
	tree = join(root, "world", "trees", "w-main", "src");
	mkdirSync(tree, { recursive: true });
	undo = queueHeavyWork({
		folder: queueFolder(jobs, {
			isRunning: () => true,
			cgroupOf: () => undefined,
		}),
		session: "session-a",
		room: () => ({
			availableGib: 40,
			memoryPressure: 0,
			vms: 0,
			cpuPressure: 0,
			cores: 16,
			pressure: { cpu: 0, memory: 0, io: 0 },
		}),
		cgroupFor: () => undefined,
	});
});
afterEach(() => {
	undo?.();
	undo = undefined;
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	rmSync(root, { recursive: true, force: true });
});

/** An exec that answers at once and remembers what it was asked. */
function recording(): { exec: Exec; asked: [string, string[]][] } {
	const asked: [string, string[]][] = [];
	return {
		asked,
		exec: async (command, args) => {
			asked.push([command, args]);
			return { code: 0, stdout: "", stderr: "" };
		},
	};
}

const queuedJobs = () =>
	readdirSync(jobs).filter((name) => name.endsWith(".job"));

describe("the work tool's git, when the queue takes it", () => {
	it("hands the queue git as the guard rewrote it", async () => {
		const direct = recording();
		const queued = recording();

		await treeExecOver(direct.exec, queued.exec)("git", [
			"-C",
			tree,
			"push",
			"origin",
			"x",
		]);

		expect(direct.asked).toEqual([]);
		const [command, args] = queued.asked[0] ?? ["", []];
		expect(command).toBe("bash");
		expect(args[1], "the guard's settings reach the queued line").toContain(
			`git -c core.fsmonitor=false -C ${tree} push origin x`,
		);
	});

	it("runs no push of a tree whose .git names a folder of its own", async () => {
		writeFileSync(join(tree, ".git"), `gitdir: ${join(root, "elsewhere")}\n`);
		const direct = recording();
		const queued = recording();

		const result = await treeExecOver(direct.exec, queued.exec)("git", [
			"-C",
			tree,
			"push",
			"origin",
			"x",
		]);

		expect(result.code, "the guard refuses it").toBe(126);
		expect(result.stderr).toContain("names no worktree");
		expect(queued.asked, "the queue never ran it").toEqual([]);
		expect(direct.asked).toEqual([]);
		expect(queuedJobs()).toEqual([]);
	});
});
