import { describe, expect, it } from "vitest";
import {
	blocksRepoint,
	createGitHistory,
	type WorkingState,
} from "../../../lib/work/history.js";
import { fakeExec } from "../../support/fake-exec.js";

const statusOf = (stdout: string) => [{ when: ["status"], stdout }];
const state = (changed: WorkingState["changed"]): WorkingState => ({
	clean: changed.length === 0,
	changed,
});

describe("reading what a tree holds", () => {
	it("calls a tree with nothing in it clean", async () => {
		const { exec } = fakeExec(statusOf(""));
		const history = createGitHistory({ exec });

		const result = await history.status("/trees/one");

		expect(result.clean).toBe(true);
		expect(result.changed).toEqual([]);
	});

	it("reads the tree it is asked about, not the process cwd", async () => {
		const { exec, calls } = fakeExec(statusOf(""));
		const history = createGitHistory({ exec });

		await history.status("/trees/one");

		expect(calls[0]?.args.slice(0, 2)).toEqual(["-C", "/trees/one"]);
	});

	it("tells a staged change from an unstaged one", async () => {
		const { exec } = fakeExec(statusOf("M  staged.ts\n M unstaged.ts\n"));
		const history = createGitHistory({ exec });

		const { changed } = await history.status("/trees/one");

		expect(changed).toEqual([
			{ path: "staged.ts", staged: true, kind: "modified" },
			{ path: "unstaged.ts", staged: false, kind: "modified" },
		]);
	});

	it("counts an untracked file as work, because a re-point destroys it", async () => {
		// The case a status check most easily misses, and the only one
		// where the work is unrecoverable rather than merely moved.
		const { exec } = fakeExec(statusOf("?? scratch.ts\n"));
		const history = createGitHistory({ exec });

		const result = await history.status("/trees/one");

		expect(result.clean).toBe(false);
		expect(result.changed).toEqual([
			{ path: "scratch.ts", staged: false, kind: "untracked" },
		]);
	});

	it("names the kinds it can distinguish", async () => {
		const { exec } = fakeExec(statusOf("A  new.ts\n D gone.ts\n"));
		const history = createGitHistory({ exec });

		const { changed } = await history.status("/trees/one");

		expect(changed.map((c) => c.kind)).toEqual(["added", "deleted"]);
	});

	it("reports a rename by where the file ended up", async () => {
		const { exec } = fakeExec(statusOf("R  old.ts -> new.ts\n"));
		const history = createGitHistory({ exec });

		const { changed } = await history.status("/trees/one");

		expect(changed).toEqual([
			{ path: "new.ts", staged: true, kind: "renamed" },
		]);
	});
});

describe("reading where a tree points", () => {
	it("gives the commit and the branch", async () => {
		const { exec } = fakeExec([
			{ when: ["rev-parse"], stdout: "abc123\n" },
			{ when: ["symbolic-ref"], stdout: "fix/thing\n" },
		]);
		const history = createGitHistory({ exec });

		expect(await history.head("/trees/one")).toEqual({
			commit: "abc123",
			branch: "fix/thing",
		});
	});

	it("reports no branch at all when the tree is detached", async () => {
		// A snapshot is detached by design, so inventing a branch name
		// here would make every snapshot look like a branch tree.
		const { exec } = fakeExec([
			{ when: ["rev-parse"], stdout: "abc123\n" },
			{ when: ["symbolic-ref"], code: 128, stderr: "fatal: ref HEAD" },
		]);
		const history = createGitHistory({ exec });

		const head = await history.head("/trees/one");

		expect(head.commit).toBe("abc123");
		expect(head).not.toHaveProperty("branch");
	});
});

describe("guarding a re-point", () => {
	it("allows a clean tree through", () => {
		expect(blocksRepoint(state([]))).toBeUndefined();
	});

	it("names the files rather than merely refusing", () => {
		// A refusal that does not say what is in the way leaves the
		// person to go and look, which is the whole cost of the refusal.
		const reason = blocksRepoint(
			state([
				{ path: "lib/thing.ts", staged: false, kind: "modified" },
				{ path: "scratch.ts", staged: false, kind: "untracked" },
			]),
		);

		expect(reason).toMatch(/lib\/thing\.ts/);
		expect(reason).toMatch(/scratch\.ts/);
	});

	it("refuses for an untracked file alone", () => {
		expect(
			blocksRepoint(
				state([{ path: "s.ts", staged: false, kind: "untracked" }]),
			),
		).toBeDefined();
	});
});
