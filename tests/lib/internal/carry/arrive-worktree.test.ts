/**
 * Arriving with a tree carried from where the work tool cuts trees,
 * through real git: it comes as a worktree of a checkout the fence
 * guards, so pi's own git runs in it, and as a clone only where no such
 * checkout holds its origin.
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import {
	type ArrivalLine,
	arrive,
} from "../../../../lib/internal/carry/arrive.ts";
import { carryAway } from "../../../../lib/internal/carry/carry-away.ts";
import { gitRun } from "../../../../lib/internal/sandbox/tree-git.ts";
import { git } from "../../../support/git-fixture.ts";
import { fakeClock, QUEST, SESSION, scratchOf } from "./support/arriving.ts";
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

/** Where the work tool cuts trees, under a home. */
const TREES = join(
	".local",
	"state",
	"pi",
	"agentic-harness.pi",
	"work",
	"trees",
);

/**
 * A tree on `topic` with a commit no remote has and a change, carried
 * from where the leaving machine's work tool cuts trees.
 */
async function carriedFromTrees() {
	const origin = await bareOrigin(made);
	const leaving = folder(made, "leaving");
	const tree = await cloneAt(origin, join(leaving, TREES, "app-topic"));
	await git(tree, "checkout", "-q", "-b", "topic");
	const head = await commit(tree, "work.txt", "unpushed\n");
	writeFileSync(join(tree, "README.md"), "changed, never committed\n");
	const from = join(folder(made, "scratch"), QUEST, "handover", "aquifer");
	await carryAway({
		exec,
		into: from,
		home: leaving,
		quest: QUEST,
		session: { id: SESSION, cwd: tree },
		trees: [tree],
	});
	return { origin, from, head };
}

/**
 * Arrives on a machine whose home is `home`, keeping every line said,
 * running its commands through `through`.
 */
async function arriveAt(home: string, from: string, through: Exec = exec) {
	const said: ArrivalLine[] = [];
	const whole = await arrive({
		exec: through,
		from,
		session: SESSION,
		home,
		scratch: scratchOf(from),
		sessions: folder(made, "store"),
		clock: fakeClock(),
		say: (line) => said.push(line),
		takeNotes: async (_quest, notes) => notes.length,
		trees: join(home, TREES),
	});
	return { whole, said, tree: join(home, TREES, "app-topic") };
}

/** The git folder the repository at `path` shares, as git names it. */
function commonOf(path: string): Promise<string> {
	return git(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
}

/** Spoils the carried patch in `from`, so the tree is refused once checked out. */
function breakPatch(from: string): void {
	const patch = readdirSync(from).find((name) => name.endsWith(".patch"));
	writeFileSync(join(from, patch ?? "none"), "no patch at all\n");
}

/**
 * `exec`, but once the tree's changes fail to apply, git answers
 * `answer` when asked which branch the tree is on.
 */
function headUnread(answer: { code: number; stderr: string }): Exec {
	let applied = false;
	return (command, args) => {
		if (args.includes("apply")) applied = true;
		return applied && args.includes("symbolic-ref")
			? Promise.resolve({ ...answer, stdout: "" })
			: exec(command, args);
	};
}

/** Why the first tree said was refused, or nothing. */
function refusalOf(said: readonly ArrivalLine[]): string {
	const first = said[0];
	return first?.kind === "tree" ? (first.why ?? "") : "";
}

describe("arriving with a tree from where the work tool cuts them", () => {
	it("cuts it as a worktree of the checkout under ~/src its origin names, so pi's git runs there", async () => {
		const { origin, from, head } = await carriedFromTrees();
		const home = folder(made, "arriving");
		const checkout = await cloneAt(origin, join(home, "src", "origin"));

		const { whole, said, tree } = await arriveAt(home, from);

		expect(whole, "it arrived whole").toBe(true);
		expect(said[0]).toEqual({
			kind: "tree",
			path: tree,
			branch: "topic",
			did: "cloned",
		});
		expect(statSync(join(tree, ".git")).isFile(), "a worktree's .git").toBe(
			true,
		);
		expect(await commonOf(tree)).toBe(join(checkout, ".git"));
		expect(await git(tree, "symbolic-ref", "--short", "HEAD")).toBe("topic");
		expect(await git(tree, "rev-parse", "HEAD")).toBe(head);
		expect(readFileSync(join(tree, "README.md"), "utf8")).toBe(
			"changed, never committed\n",
		);
		expect(
			gitRun(tree, ["status"], {
				home,
				fenced: true,
				trees: join(home, TREES),
			}),
			"pi's own git, outside the fence, runs in it",
		).not.toHaveProperty("refused");
	});

	it("finds the checkout through a sibling tree cut from it", async () => {
		const { origin, from } = await carriedFromTrees();
		const home = folder(made, "arriving");
		const checkout = await cloneAt(origin, join(home, "src", "named-apart"));
		await git(
			checkout,
			"worktree",
			"add",
			"-q",
			"-b",
			"sibling",
			join(home, TREES, "app-sibling"),
		);

		const { whole, tree } = await arriveAt(home, from);

		expect(whole, "the tree arrives whole").toBe(true);
		expect(await commonOf(tree)).toBe(join(checkout, ".git"));
	});

	it("refuses a branch the checkout has checked out, leaving it where it is", async () => {
		const { origin, from } = await carriedFromTrees();
		const home = folder(made, "arriving");
		const checkout = await cloneAt(origin, join(home, "src", "origin"));
		await git(checkout, "checkout", "-q", "-b", "topic");
		const held = await git(checkout, "rev-parse", "HEAD");

		const { whole, said, tree } = await arriveAt(home, from);

		expect(whole, "a refused tree isn't whole").toBe(false);
		expect(said[0]).toEqual({
			kind: "tree",
			path: tree,
			branch: "topic",
			did: "refused",
			why: `Its branch topic is checked out at ${checkout}, which shares its branches, so it isn't moved from under it.`,
		});
		expect(existsSync(tree), "nothing is cut").toBe(false);
		expect(await git(checkout, "rev-parse", "topic")).toBe(held);
	});

	it("refuses where the checkout's branch has commits the carried one lacks, taking out what it cut", async () => {
		const { origin, from } = await carriedFromTrees();
		const home = folder(made, "arriving");
		const checkout = await cloneAt(origin, join(home, "src", "origin"));
		await git(checkout, "checkout", "-q", "-b", "topic");
		await commit(checkout, "other.txt", "only here\n");
		await git(checkout, "checkout", "-q", "main");

		const { whole, said, tree } = await arriveAt(home, from);

		expect(whole, "a refused tree isn't whole").toBe(false);
		expect(said[0]).toMatchObject({
			kind: "tree",
			path: tree,
			did: "refused",
			why: "Its branch topic here has commits the carried one lacks.",
		});
		expect(existsSync(tree), "the cut tree is taken out").toBe(false);
		expect(
			await git(checkout, "worktree", "list", "--porcelain"),
			"and git keeps no entry for it",
		).not.toContain(tree);
	});

	it.each([
		["takes out the branch it made", false],
		["puts the branch back where it stood", true],
	])("refused once cut, %s in the checkout", async (_, branched) => {
		const { origin, from } = await carriedFromTrees();
		const home = folder(made, "arriving");
		const checkout = await cloneAt(origin, join(home, "src", "origin"));
		if (branched) await git(checkout, "branch", "topic");
		const stood = branched
			? await git(checkout, "rev-parse", "topic")
			: undefined;
		// Its changes no longer apply, so it is refused after its checkout.
		const patch = readdirSync(from).find((name) => name.endsWith(".patch"));
		writeFileSync(join(from, patch ?? "none"), "no patch at all\n");

		const { whole, said, tree } = await arriveAt(home, from);

		expect(whole, "a refused arrival is not whole").toBe(false);
		expect(said[0]).toMatchObject({ did: "refused" });
		expect(String(said[0]?.kind === "tree" && said[0].why)).toMatch(
			/^Its changes didn't apply/,
		);
		expect(existsSync(tree), `${tree} isn't there`).toBe(false);
		const now = await exec("git", [
			"-C",
			checkout,
			"rev-parse",
			"--verify",
			"-q",
			"refs/heads/topic",
		]);
		expect(now.code === 0 ? now.stdout.trim() : undefined).toBe(stood);
	});

	it.each([
		["git fails", { code: 128, stderr: "fatal: broken\n" }, "fatal: broken"],
		// As spawnExec answers for a git killed from outside (#2119).
		[
			"git is killed by a signal",
			{ code: 137, stderr: "git was killed by SIGKILL" },
			"git was killed by SIGKILL",
		],
	])(
		"says it left the branch where %s saying which branch the refused tree was on",
		async (_, answer, words) => {
			const { origin, from, head } = await carriedFromTrees();
			const home = folder(made, "arriving");
			const checkout = await cloneAt(origin, join(home, "src", "origin"));
			breakPatch(from);

			const { whole, said, tree } = await arriveAt(
				home,
				from,
				headUnread(answer),
			);

			expect(whole, "a refused arrival is not whole").toBe(false);
			expect(refusalOf(said)).toMatch(
				new RegExp(
					`^Its changes didn't apply.*And its branch topic may be left at ${head}, though there was no such branch before, since git couldn't say which branch the tree was on: ${words}\\.$`,
					"s",
				),
			);
			expect(existsSync(tree), "the cut tree is taken out").toBe(false);
			expect(
				await git(checkout, "rev-parse", "topic"),
				"left where settling put it, as said",
			).toBe(head);
		},
	);

	it("says where the branch it may have left stood before, where it stood", async () => {
		const { origin, from, head } = await carriedFromTrees();
		const home = folder(made, "arriving");
		const checkout = await cloneAt(origin, join(home, "src", "origin"));
		await git(checkout, "branch", "topic");
		const stood = await git(checkout, "rev-parse", "topic");
		breakPatch(from);

		const { whole, said } = await arriveAt(
			home,
			from,
			headUnread({ code: 128, stderr: "fatal: broken\n" }),
		);

		expect(whole, "an arrival that may have left the branch is not whole").toBe(
			false,
		);
		expect(refusalOf(said)).toMatch(
			new RegExp(
				`And its branch topic may be left at ${head}, where it stood at ${stood} before, since git couldn't say which branch the tree was on: fatal: broken\\.$`,
			),
		);
		expect(
			await git(checkout, "rev-parse", "topic"),
			"left where settling put it, as said",
		).toBe(head);
	});

	it("clones it as before where no checkout the fence guards holds its origin", async () => {
		const { origin, from, head } = await carriedFromTrees();
		const home = folder(made, "arriving");
		const outside = await cloneAt(
			origin,
			join(folder(made, "elsewhere"), "origin"),
		);

		const { whole, tree } = await arriveAt(home, from);

		expect(whole, "the clone arrives whole").toBe(true);
		expect(
			statSync(join(tree, ".git")).isDirectory(),
			"a clone of its own",
		).toBe(true);
		expect(await git(tree, "rev-parse", "HEAD")).toBe(head);
		expect(await git(outside, "worktree", "list", "--porcelain")).not.toContain(
			tree,
		);
	});
});
