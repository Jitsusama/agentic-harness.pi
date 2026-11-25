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
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	treeExec,
	treeExecOver,
} from "../../../extensions/work-integration/broker.ts";
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

/** The jobs the queue was asked to run, as it wrote them. */
const asked = () =>
	queuedJobs().map((name) =>
		JSON.parse(readFileSync(join(jobs, name), "utf8")),
	);

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
		// The tree holds no git, so the queue runs it in the folder the
		// guard read, behind a look at it again.
		expect(args[1], "the guard's settings reach the queued line").toContain(
			`pi-unrooted-git ${realpathSync(tree)} git -c core.fsmonitor=false push origin x`,
		);
		expect(asked(), "the queue names the push as it was asked").toMatchObject([
			{ what: `git -C ${tree} push origin x`, walk: "push" },
		]);
	});

	it("runs a fetch behind its checkout's turn inside the queue, after the guard", async () => {
		const direct = recording();
		const queued = recording();
		const commit = "0123abcd";

		await treeExecOver(direct.exec, queued.exec, async () => ({
			through: "turn",
		}))("git", ["-C", tree, "fetch", "--quiet", "origin", commit]);

		const [command, args] = queued.asked[0] ?? ["", []];
		expect(command, "the queue didn't take the fetch").toBe("bash");
		expect(args[1], "the turn didn't wrap the guarded git").toContain(
			`'turn "$@"' work-fetch bash -c `,
		);
		expect(args[1], "the guard's look runs inside the turn").toContain(
			`pi-unrooted-git ${realpathSync(tree)} git -c core.fsmonitor=false fetch --quiet origin ${commit}`,
		);
		// The queue cuts the long line it names a job by, so its start.
		expect(
			asked()[0]?.what,
			"the queue names the fetch as it was asked",
		).toMatch(new RegExp(`^git -C ${tree} fetch --quiet origin 0`));
	});

	it("guards the push's own git the same way", async () => {
		writeFileSync(join(tree, ".git"), `gitdir: ${join(root, "elsewhere")}\n`);

		const result = await treeExec()("git", ["-C", tree, "push", "origin", "x"]);

		expect(result.code, "the guard refuses it").toBe(126);
		expect(queuedJobs()).toEqual([]);
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
