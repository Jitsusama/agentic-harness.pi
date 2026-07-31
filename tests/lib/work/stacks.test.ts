/**
 * Keeping a stack in the repository, and replaying it.
 *
 * The argv matters here more than usual. A replay without a boundary is the
 * difference between restacking a branch and handing it duplicates of every
 * commit its parent carries, and both look like success.
 */

import { describe, expect, it, vi } from "vitest";
import type { WorkRebaser } from "../../../lib/work/rebase.js";
import { createGitStacks } from "../../../lib/work/stacks.js";
import { fakeExec, type Reply } from "../review/support/fake-exec.js";

const TREE = "/trees/topic";

/** A rebaser that reports nothing in progress. */
function settled(): WorkRebaser {
	return {
		halted: vi.fn(async () => false),
		rebase: vi.fn(),
		resume: vi.fn(),
		abandon: vi.fn(),
	} as unknown as WorkRebaser;
}

/**
 * Config output for a three-high stack.
 *
 * Lowercase keys, because that is what git stores: config variable names are
 * case-insensitive and normalized, so a key written as `workParent` reads back
 * as `workparent`. Writing one spelling and comparing the other made every
 * branch read as untracked, and a fake spelling it the caller's way could not
 * have shown that.
 */
const CONFIG = [
	"branch.a.workparent ",
	"branch.a.workbase trunk1",
	"branch.b.workparent a",
	"branch.b.workbase a1",
	"branch.c.workparent b",
	"branch.c.workbase b1",
].join("\n");

/** Replies for a tree holding that stack. */
const holding: Reply[] = [
	{ when: ["config", "--get-regexp"], stdout: `${CONFIG}\n` },
	{
		when: ["for-each-ref"],
		stdout: "a\nb\nc\nmain\n",
	},
	{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "c\n" },
	{ when: ["rev-parse", "--verify"], stdout: "tip0\n" },
	{ when: ["merge-base"], stdout: "mb0\n" },
	{ when: ["checkout"], code: 0 },
	{ when: ["config", "branch."], code: 0 },
	{ when: ["rebase"], code: 0 },
];

/**
 * Every rebase git was asked to run, as strings.
 *
 * The global flags that turn the editor off are dropped, because this asserts what
 * was replayed onto what. Keeping them put a constant on the front of every
 * expected string, which is noise that hides the one part that differs, and it
 * made these cases fail when the editor was disabled rather than when a replay
 * went to the wrong base. The flags have a test of their own.
 */
function replays(calls: { args: string[] }[]): string[] {
	return calls
		.filter((call) => call.args.includes("rebase"))
		.map((call) => {
			const kept: string[] = [];
			for (let at = 0; at < call.args.length; at += 1) {
				if (call.args[at] === "-c") {
					at += 1;
					continue;
				}
				kept.push(call.args[at]);
			}
			return kept.join(" ");
		});
}

describe("reading a stack from the repository", () => {
	it("reads parentage and base out of git config", async () => {
		// Stored in the repository rather than this package's state, so the
		// record cannot outlive the branches it names.
		const { exec } = fakeExec(holding);

		const held = await createGitStacks({ exec, rebaser: settled() }).read(TREE);

		expect(held).toEqual([
			{ name: "a", base: "trunk1" },
			{ name: "b", parent: "a", base: "a1" },
			{ name: "c", parent: "b", base: "b1" },
		]);
	});

	it("keeps the dots in a branch name", async () => {
		// `branch.<name>.workParent` with a dotted branch name only parses if
		// the name is taken as everything between the outer separators.
		const { exec } = fakeExec([
			{
				when: ["config", "--get-regexp"],
				stdout: "branch.release/2.1.workparent main\n",
			},
		]);

		const held = await createGitStacks({ exec, rebaser: settled() }).read(TREE);

		expect(held).toEqual([{ name: "release/2.1", parent: "main" }]);
	});

	it("reads an empty record as a stack of nothing", async () => {
		const { exec } = fakeExec([{ when: ["config", "--get-regexp"], code: 1 }]);

		expect(
			await createGitStacks({ exec, rebaser: settled() }).read(TREE),
		).toEqual([]);
	});
});

describe("replaying a stack", () => {
	it("replays each branch from its recorded base onto its parent", async () => {
		const { exec, calls } = fakeExec(holding);

		const outcome = await createGitStacks({
			exec,
			rebaser: settled(),
		}).restack(TREE, "main");

		expect(outcome.kind).toBe("restacked");
		// The boundary is the recorded base, and it is what stops the branch
		// being handed its parent's commits a second time.
		expect(replays(calls)).toEqual([
			`-C ${TREE} rebase --onto main trunk1`,
			`-C ${TREE} rebase --onto a a1`,
			`-C ${TREE} rebase --onto b b1`,
		]);
	});

	it("replays in order, roots first", async () => {
		const { exec, calls } = fakeExec(holding);

		await createGitStacks({ exec, rebaser: settled() }).restack(TREE, "main");

		const order = calls
			.filter((call) => call.args.includes("checkout"))
			.map((call) => call.args[call.args.length - 1]);
		expect(order.slice(0, 3)).toEqual(["a", "b", "c"]);
	});

	it("puts the tree back on the branch it started on", async () => {
		// A restack that leaves you on whatever it replayed last has moved you
		// without asking.
		const { exec, calls } = fakeExec(holding);

		const outcome = await createGitStacks({
			exec,
			rebaser: settled(),
		}).restack(TREE, "main");

		expect(outcome).toMatchObject({ on: "c" });
		const checkouts = calls
			.filter((call) => call.args.includes("checkout"))
			.map((call) => call.args[call.args.length - 1]);
		expect(checkouts[checkouts.length - 1]).toBe("c");
	});

	it("falls back to a merge-base when no base was recorded", async () => {
		const { exec, calls } = fakeExec([
			{
				when: ["config", "--get-regexp"],
				stdout: "branch.a.workparent \nbranch.b.workparent a\n",
			},
			...holding.slice(1),
		]);

		await createGitStacks({ exec, rebaser: settled() }).restack(TREE, "main");

		expect(replays(calls).join("\n")).toContain("--onto main mb0");
	});

	it("records the new base after each replay, so the next restack is a no-op", async () => {
		const { exec, calls } = fakeExec(holding);

		await createGitStacks({ exec, rebaser: settled() }).restack(TREE, "main");

		const written = calls
			.filter((call) => call.args.some((arg) => arg.endsWith(".workbase")))
			.map((call) => call.args.join(" "));
		expect(written.length).toBeGreaterThanOrEqual(3);
	});

	it("skips a branch already sitting on its parent's tip", async () => {
		const { exec } = fakeExec([
			{
				when: ["config", "--get-regexp"],
				stdout: "branch.a.workparent \nbranch.a.workbase tip0\n",
			},
			...holding.slice(1),
		]);

		const outcome = await createGitStacks({
			exec,
			rebaser: settled(),
		}).restack(TREE, "main");

		if (outcome.kind !== "restacked") throw new Error("expected a restack");
		expect(outcome.results[0]).toMatchObject({ outcome: "already-there" });
	});
});

describe("a restack that halts", () => {
	it("stops, and says what it never reached", async () => {
		// Carrying on would replay later branches onto a parent that is
		// mid-rebase, producing a stack built on a commit about to be rewritten.
		const { exec } = fakeExec([
			...holding.filter((reply) => !reply.when.includes("rebase")),
			// Matched as one fragment against the joined args. A bare "a" also
			// appears inside "main", so the root's replay would fail instead.
			{ when: ["rebase --onto a a1"], code: 1 },
			{ when: ["rebase"], code: 0 },
			{ when: ["--diff-filter=U"], stdout: "lib/work/tree.ts\n" },
		]);

		const outcome = await createGitStacks({
			exec,
			rebaser: settled(),
		}).restack(TREE, "main");

		expect(outcome).toMatchObject({
			kind: "halted",
			at: "b",
			conflicted: ["lib/work/tree.ts"],
		});
		if (outcome.kind !== "halted") return;
		expect(outcome.results).toEqual([
			{ branch: "a", onto: "main", outcome: "replayed" },
			{
				branch: "b",
				onto: "a",
				outcome: "halted",
				conflicted: ["lib/work/tree.ts"],
			},
			{ branch: "c", onto: "b", outcome: "skipped" },
		]);
	});

	it("refuses to start over a replay that is already halted", async () => {
		const rebaser = settled();
		rebaser.halted = vi.fn(async () => true);
		const { exec } = fakeExec(holding);

		const outcome = await createGitStacks({ exec, rebaser }).restack(
			TREE,
			"main",
		);

		expect(outcome).toMatchObject({ kind: "refused" });
	});

	it("refuses when nothing is tracked, and says what to do", async () => {
		const { exec } = fakeExec([
			{ when: ["config", "--get-regexp"], code: 1 },
			...holding.slice(1),
		]);

		const outcome = await createGitStacks({
			exec,
			rebaser: settled(),
		}).restack(TREE, "main");

		expect(outcome).toMatchObject({ kind: "refused" });
		if (outcome.kind !== "refused") return;
		expect(outcome.reason).toContain("Track a branch");
	});
});

describe("changing the shape of a stack", () => {
	it("refuses to track a branch that does not exist", async () => {
		const { exec } = fakeExec(holding);

		const outcome = await createGitStacks({
			exec,
			rebaser: settled(),
		}).track(TREE, "nope", "a");

		expect(outcome).toMatchObject({ kind: "refused" });
	});

	it("refuses a parent that does not exist", async () => {
		const { exec } = fakeExec(holding);

		const outcome = await createGitStacks({
			exec,
			rebaser: settled(),
		}).track(TREE, "a", "nope");

		expect(outcome).toMatchObject({ kind: "refused" });
	});

	it("moves whatever sat on an untracked branch down onto its parent", async () => {
		// Leaving them pointing at a branch nobody tracks makes the stack
		// unorderable by removing one member of it.
		const { exec } = fakeExec(holding);

		const outcome = await createGitStacks({
			exec,
			rebaser: settled(),
		}).untrack(TREE, "b");

		expect(outcome).toMatchObject({ kind: "shaped", changed: ["b", "c"] });
	});

	it("refuses a reparent that would close a loop", async () => {
		const { exec } = fakeExec(holding);

		const outcome = await createGitStacks({
			exec,
			rebaser: settled(),
		}).reparent(TREE, "a", "c");

		expect(outcome).toMatchObject({ kind: "faulted" });
	});

	it("says a reparent to where it already sits changed nothing", async () => {
		const { exec } = fakeExec(holding);

		const outcome = await createGitStacks({
			exec,
			rebaser: settled(),
		}).reparent(TREE, "c", "b");

		expect(outcome).toMatchObject({ kind: "unchanged" });
	});

	it("writes the parentage a reorder implies", async () => {
		const { exec, calls } = fakeExec(holding);

		const outcome = await createGitStacks({
			exec,
			rebaser: settled(),
		}).reorder(TREE, ["a", "c", "b"]);

		expect(outcome).toMatchObject({ kind: "shaped", changed: ["c", "b"] });
		const written = calls
			.filter((call) => call.args.some((arg) => arg.endsWith(".workparent")))
			.map((call) => call.args.slice(-2).join(" "));
		expect(written).toContain("branch.c.workparent a");
		expect(written).toContain("branch.b.workparent c");
	});
});
