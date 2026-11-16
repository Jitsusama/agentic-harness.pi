/**
 * Letting the old place go once a carried session has arrived, through
 * real git: a worktree holding only what was carried goes, one holding
 * anything since stays and is named, and a checkout of its own stays.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { carryAway } from "../../../../lib/internal/carry/carry-away.ts";
import {
	holderIn,
	lsofCwds,
	processCwds,
	type SettleLine,
	settle,
} from "../../../../lib/internal/carry/settle.ts";
import { git } from "../../../support/git-fixture.ts";
import {
	bareOrigin,
	cloneAt,
	commit,
	exec,
	folder,
	removeAll,
} from "./support/machines.ts";

const made: string[] = [];
afterEach(() => removeAll(made));

const QUEST = "QEST-20261116-SETTLE";

/**
 * A home with a checkout at `~/src/app` and a worktree of it on `topic`
 * at `~/trees/app-topic`, holding an unpushed commit and a change.
 */
async function homeWithWorktree() {
	const origin = await bareOrigin(made);
	const home = folder(made, "home");
	const checkout = await cloneAt(origin, join(home, "src", "app"));
	const tree = join(home, "trees", "app-topic");
	mkdirSync(join(home, "trees"), { recursive: true });
	await git(checkout, "worktree", "add", "-q", "-b", "topic", tree);
	await commit(tree, "work.txt", "unpushed\n");
	writeFileSync(join(tree, "README.md"), "changed, never committed\n");
	const from = join(folder(made, "scratch"), QUEST, "handover", "kestrel");
	return { home, checkout, tree, from };
}

async function carried(
	home: string,
	from: string,
	trees: readonly string[],
): Promise<void> {
	await carryAway({
		exec,
		into: from,
		home,
		quest: QUEST,
		session: { id: "s-1", cwd: trees[0] ?? home },
		trees,
	});
}

async function settled(
	home: string,
	from: string,
	{ runsHere = false, holder }: { runsHere?: boolean; holder?: string } = {},
): Promise<{ whole: boolean; lines: SettleLine[]; forgot: string[] }> {
	const lines: SettleLine[] = [];
	const forgot: string[] = [];
	const whole = await settle({
		exec,
		from,
		session: "s-1",
		home,
		runsHere,
		holderOf: async () => holder,
		forget: (folder) => forgot.push(folder),
		say: (line) => lines.push(line),
	});
	return { whole, lines, forgot };
}

describe("letting the old place go", () => {
	it("lets go of a worktree holding only what was carried, and keeps its branch", async () => {
		const { home, checkout, tree, from } = await homeWithWorktree();
		const head = await git(tree, "rev-parse", "HEAD");
		await carried(home, from, [tree]);

		const { whole, lines, forgot } = await settled(home, from);

		expect(forgot, "its broker record is dropped").toEqual([tree]);
		expect(lines).toEqual([
			{ kind: "tree", path: "~/trees/app-topic", did: "let go" },
			{ kind: "settled", session: "s-1", let: 1 },
		]);
		expect(whole, "it settled").toBe(true);
		expect(existsSync(tree), "the worktree is gone").toBe(false);
		expect(
			await git(checkout, "rev-parse", "topic"),
			"its branch still names its commit",
		).toBe(head);
	});

	it("keeps every tree when one has a commit the carry lacks, naming it", async () => {
		const { home, tree, from } = await homeWithWorktree();
		await carried(home, from, [tree]);
		await commit(tree, "later.txt", "after the carry\n");

		const { whole, lines } = await settled(home, from);

		expect(whole, "it didn't settle").toBe(false);
		expect(lines[0]).toMatchObject({
			kind: "tree",
			path: "~/trees/app-topic",
			did: "kept",
		});
		expect(lines[0]?.kind === "tree" ? lines[0].why : "").toMatch(
			/commits since the carry/,
		);
		expect(lines.at(-1)).toMatchObject({ kind: "failed" });
		expect(existsSync(tree), "the worktree stays").toBe(true);
	});

	it("keeps a tree whose uncommitted changes differ from those carried", async () => {
		const { home, tree, from } = await homeWithWorktree();
		await carried(home, from, [tree]);
		writeFileSync(join(tree, "new.txt"), "written after the carry\n");

		const { whole, lines } = await settled(home, from);

		expect(whole, "it didn't settle").toBe(false);
		expect(lines[0]?.kind === "tree" ? lines[0].why : "").toMatch(
			/uncommitted changes differ/,
		);
		expect(existsSync(join(tree, "new.txt")), "nothing was lost").toBe(true);
	});

	it("leaves a checkout of its own where it is, since only worktrees are let go", async () => {
		const { home, checkout, from } = await homeWithWorktree();
		await carried(home, from, [checkout]);

		const { whole, lines } = await settled(home, from);

		expect(lines[0]).toMatchObject({
			kind: "tree",
			path: "~/src/app",
			did: "stays",
		});
		expect(whole, "a checkout staying doesn't stop it settling").toBe(true);
		expect(existsSync(checkout), "the checkout stays").toBe(true);
	});

	it("says a tree already gone is gone, so settling twice is settled", async () => {
		const { home, tree, from } = await homeWithWorktree();
		await carried(home, from, [tree]);
		await settled(home, from);

		const { whole, lines } = await settled(home, from);

		expect(lines).toEqual([
			{ kind: "tree", path: "~/trees/app-topic", did: "gone" },
			{ kind: "settled", session: "s-1", let: 0 },
		]);
		expect(whole, "settled again").toBe(true);
	});

	it("refuses while the session runs on this machine, letting nothing go", async () => {
		const { home, tree, from } = await homeWithWorktree();
		await carried(home, from, [tree]);

		const { whole, lines } = await settled(home, from, { runsHere: true });

		expect(whole, "it didn't settle").toBe(false);
		expect(lines).toEqual([
			{
				kind: "failed",
				why: "Session s-1 runs on this machine again, so its place here is still in use.",
			},
		]);
		expect(existsSync(tree), "the worktree stays").toBe(true);
	});

	it("keeps a tree something live here stands in, though it changed nothing", async () => {
		const { home, tree, from } = await homeWithWorktree();
		await carried(home, from, [tree]);

		const { whole, lines } = await settled(home, from, {
			holder: "Process 42 works inside it.",
		});

		expect(whole, "it didn't settle").toBe(false);
		expect(lines[0]).toEqual({
			kind: "tree",
			path: "~/trees/app-topic",
			did: "kept",
			why: "Process 42 works inside it.",
		});
		expect(existsSync(tree), "the worktree stays").toBe(true);
	});

	it("refuses when no done file names the session", async () => {
		const { home, from } = await homeWithWorktree();

		const { whole, lines } = await settled(home, from);

		expect(whole, "nothing to settle").toBe(false);
		expect(lines).toEqual([
			{
				kind: "failed",
				why: `No done file in ${from} names session s-1, so nothing here was carried to let go.`,
			},
		]);
	});
});

describe("what stands in a tree here", () => {
	it("names a live session the work broker's record says holds it", async () => {
		const tree = folder(made, "held");

		const why = await holderIn(tree, {
			brokerHolds: async () => 2,
			cwds: async () => [],
			self: process.pid,
		});

		expect(why).toBe("The work broker's record says 2 live sessions hold it.");
	});

	it("names a process working inside it, and none beside it", async () => {
		const tree = realpathSync(folder(made, "app"));
		const holders = (cwd: string) => ({
			brokerHolds: async () => 0,
			cwds: async () => [{ pid: 4242, cwd }],
			self: process.pid,
		});

		expect(await holderIn(tree, holders(join(tree, "src")))).toBe(
			"Process 4242 works inside it, so letting it go would pull its folder out from under it.",
		);
		expect(
			await holderIn(tree, holders(`${tree}-sibling`)),
			"a folder whose name merely starts the same is elsewhere",
		).toBeUndefined();
		expect(
			await holderIn(tree, { ...holders(tree), self: 4242 }),
			"and the process asking never holds it",
		).toBeUndefined();
	});

	it("finds a real process standing in a folder", async () => {
		const tree = realpathSync(folder(made, "stood-in"));
		// Waits until killed, standing in the tree meanwhile.
		const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], {
			cwd: tree,
			stdio: "ignore",
		});
		try {
			const pid = child.pid ?? -1;
			const cwds = await processCwds(exec);
			expect(
				cwds.find((one) => one.pid === pid)?.cwd,
				"the child's folder is read",
			).toBe(tree);
		} finally {
			child.kill();
		}
	});

	it("reads lsof's folders as a Mac lists them", () => {
		expect(
			lsofCwds("p12\nfcwd\nn/Users/joel/src/app\np40\nfcwd\nn/\n"),
		).toEqual([
			{ pid: 12, cwd: "/Users/joel/src/app" },
			{ pid: 40, cwd: "/" },
		]);
	});
});
