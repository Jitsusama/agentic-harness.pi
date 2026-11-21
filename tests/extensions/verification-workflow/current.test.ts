/**
 * What a commit is told of a failed run while git takes its time.
 *
 * Git is asked off the thread, so the state can change before it
 * answers: an edit or a clean verify clears the run, or a new verify
 * records another. Each answer is about the run it asked of, and a run
 * git couldn't answer for is neither held against a commit nor
 * forgotten.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	commitCheck,
	failureNow,
	settle,
} from "../../../extensions/verification-workflow/current.ts";
import {
	createVerificationState,
	type FailedRun,
	type VerificationState,
} from "../../../extensions/verification-workflow/state.ts";

/** Each fingerprint asked for, answered when the test says. */
const asked: ((print: string | undefined) => void)[] = [];
/** Whether the run's root is still on disk. */
const disk = { there: true };
/** The repository git names for a folder, or none when it gives no answer. */
const git: { top: string | undefined } = { top: "/src/repo" };

// Only git and the disk are faked: which folder lies within which is
// the real rule, so a sibling sharing a prefix is told apart.
vi.mock(
	"../../../extensions/verification-workflow/tree.ts",
	async (actual) => ({
		...(await actual<
			typeof import("../../../extensions/verification-workflow/tree.ts")
		>()),
		gitRoot: async () => git.top,
		present: async () => disk.there,
		treeFingerprint: () =>
			new Promise<string | undefined>((answer) => asked.push(answer)),
	}),
);

/** Wait until git has been asked for a fingerprint. */
async function gitAsked(): Promise<void> {
	await vi.waitFor(() => expect(asked, "a git asked").not.toHaveLength(0));
}

/** Answer the oldest fingerprint still asked for with `print`. */
async function gitSays(print: string | undefined): Promise<void> {
	await gitAsked();
	asked.shift()?.(print);
}

const RUN: FailedRun = {
	root: "/src/repo",
	command: "pnpm check",
	fingerprint: "judged",
};
const NEXT: FailedRun = { ...RUN, command: "pnpm test", fingerprint: "now" };

let state: VerificationState;

/** Record `run` as its project's failed run. */
function record(run: FailedRun): void {
	state.failedRuns.set(run.root, run);
}

/** The failed run recorded for the repository. */
function repoRun(): FailedRun | undefined {
	return state.failedRuns.get(RUN.root);
}

/** Let whatever is ready run, before counting what it asked. */
async function settled(): Promise<void> {
	// One macrotask: every promise already answered has run by then.
	await new Promise((done) => setTimeout(done, 0));
}

beforeEach(() => {
	asked.length = 0;
	disk.there = true;
	git.top = "/src/repo";
	state = createVerificationState();
	record(RUN);
});

describe("a commit's check", () => {
	it("holds back a commit on a run whose tree git says is the same", async () => {
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitSays("judged");
		const { failure } = await checking;
		expect(failure?.problems[0]).toContain("pnpm check failed");
		expect(failure?.problems[0]).toContain(
			"Run verify with path /src/repo once",
		);
	});

	it("asks again for a run recorded while git answered for the last", async () => {
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitAsked();
		record(NEXT);
		await gitSays("moved on");
		await gitSays("now");
		const { failure, judged } = await checking;
		expect(failure?.problems[0]).toContain("pnpm test failed");
		expect(judged.map((one) => one.run)).toEqual([NEXT]);
		expect(repoRun()).toBe(NEXT);
	});

	it("holds back a commit from below a run git names the repository of", async () => {
		const checking = failureNow(state, { dir: "/src/repo/lib" }, undefined);
		await gitSays("judged");
		const { failure } = await checking;
		expect(failure?.problems[0]).toContain("pnpm check failed");
	});

	it("holds no commit on a guess about a run above a folder git was silent on", async () => {
		// It may be another repository's, as a submodule's parent is.
		git.top = undefined;
		const checking = failureNow(state, { dir: "/src/repo/lib" }, undefined);
		await settled();
		const after = asked.length;
		// Answer any it asked, so a guess fails rather than hangs.
		for (const answer of asked.splice(0)) answer("judged");
		const { failure } = await checking;
		expect(failure).toBeUndefined();
		expect(after, "fingerprints asked").toBe(0);
	});

	it("holds no commit on a run in a folder whose name only begins the same", async () => {
		state.failedRuns.clear();
		record({ ...RUN, root: "/src/repo-other" });
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await settled();
		const after = asked.length;
		// Answer any it asked, so a wrong scope fails rather than hangs.
		for (const answer of asked.splice(0)) answer("judged");
		const { failure } = await checking;
		expect(failure).toBeUndefined();
		expect(after, "fingerprints asked").toBe(0);
	});

	it("holds back a commit on each failed run its repository holds", async () => {
		const lib = { ...RUN, root: "/src/repo/lib", command: "pnpm lint" };
		record(lib);
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitSays("judged");
		await gitSays("judged");
		const { failure } = await checking;
		expect(failure?.problems).toHaveLength(2);
		expect(failure?.problems.join("\n")).toContain("pnpm lint failed");
	});

	// Three asks bound a check that verifies keep overtaking; the newest
	// then holds the commit as it was recorded, without asking git again.
	it("holds the commit on the newest run after three recorded meanwhile", async () => {
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		const newest = { ...NEXT, command: "pnpm lint" };
		for (const next of [NEXT, { ...NEXT }, newest]) {
			await gitAsked();
			record(next);
			await gitSays("now");
		}
		await settled();
		const after = asked.length;
		// Answer any it asked, so a failing count fails rather than hangs.
		for (const answer of asked.splice(0)) answer("now");
		const { failure, judged, leave } = await checking;
		expect(failure?.problems[0]).toMatch(/pnpm lint failed .* while this/);
		expect(failure?.problems[0]).toContain(
			"Run verify with path /src/repo once",
		);
		expect(after, "fingerprints asked after the bound").toBe(0);
		expect(judged).toEqual([]);
		expect([...leave]).toEqual([RUN.root]);
		expect(repoRun()).toBe(newest);
	});

	it("settles a commit's outcome past the bound without asking git again", async () => {
		state.outcome = "failing";
		const checking = commitCheck(state, { dir: "/src/repo" }, undefined);
		const newest = { ...NEXT, command: "pnpm lint" };
		for (const next of [NEXT, { ...NEXT }, newest]) {
			await gitAsked();
			record(next);
			await gitSays("now");
		}
		await settled();
		const after = asked.length;
		// Answer any it asked, so a failing count fails rather than hangs.
		for (const answer of asked.splice(0)) answer("now");
		expect((await checking)?.problems[0]).toMatch(
			/pnpm lint failed .* while this/,
		);
		expect(after, "fingerprints asked after the bound").toBe(0);
		expect(state.outcome).toBe("failing");
		expect(repoRun()).toBe(newest);
	});

	it("holds the commit on its own project's run while another project's is recorded", async () => {
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitAsked();
		const elsewhere = { ...NEXT, root: "/src/other" };
		record(elsewhere);
		await gitSays("judged");
		const { failure } = await checking;
		expect(failure?.problems).toHaveLength(1);
		expect(failure?.problems[0]).toContain("pnpm check failed in /src/repo");
		expect(repoRun()).toBe(RUN);
		expect(state.failedRuns.get(elsewhere.root)).toBe(elsewhere);
	});

	it("holds back a commit on a run recorded in another of its projects while git answered", async () => {
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitAsked();
		record({ ...RUN, root: "/src/repo/lib", command: "pnpm lint" });
		await gitSays("judged");
		await gitSays("judged");
		const { failure } = await checking;
		expect(failure?.problems).toHaveLength(2);
		expect(failure?.problems.join("\n")).toContain("pnpm lint failed");
	});

	it("holds back a commit on a run recorded again in a project already asked about", async () => {
		record({ ...RUN, root: "/src/repo/lib", command: "pnpm lint" });
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitSays("moved on");
		await gitAsked();
		record({ ...NEXT, fingerprint: "judged" });
		await gitSays("judged");
		await settled();
		// Answer any it asked, so one never asked fails rather than hangs.
		for (const answer of asked.splice(0)) answer("judged");
		const { failure } = await checking;
		expect(failure?.problems.join("\n")).toContain("pnpm test failed");
		expect(failure?.problems).toHaveLength(2);
	});

	it("holds a commit on no run git couldn't answer for when its project was asked again", async () => {
		const lib = { ...RUN, root: "/src/repo/lib", command: "pnpm lint" };
		record(lib);
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitSays("judged");
		await gitAsked();
		record(NEXT);
		await gitSays("judged");
		// Asked again for its newest run, which git gives no answer for.
		await gitSays(undefined);
		const { failure } = await checking;
		expect(failure?.problems).toEqual([
			expect.stringContaining("pnpm lint failed in /src/repo/lib"),
		]);
		expect(repoRun(), "kept").toBe(NEXT);
	});

	it("holds a commit on no run git retired when its project was asked again", async () => {
		const lib = { ...RUN, root: "/src/repo/lib", command: "pnpm lint" };
		record(lib);
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitSays("judged");
		await gitAsked();
		record(NEXT);
		await gitSays("judged");
		// Asked again for its newest run, which a write since has moved.
		await gitSays("moved on");
		const { failure } = await checking;
		expect(failure?.problems).toEqual([
			expect.stringContaining("pnpm lint failed in /src/repo/lib"),
		]);
		expect(repoRun(), "retired").toBeUndefined();
	});

	it("asks no more about a project overtaken past the bound, though it records again", async () => {
		record({ ...RUN, root: "/src/repo/lib", command: "pnpm lint" });
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		for (const next of [NEXT, { ...NEXT }, { ...NEXT }]) {
			await gitAsked();
			record(next);
			await gitSays("now");
		}
		// Now lib's turn; a verify of the repository records once more.
		await gitAsked();
		record({ ...NEXT, command: "pnpm build" });
		await gitSays("judged");
		await settled();
		const after = asked.length;
		// Answer any it asked, so a failing count fails rather than hangs.
		for (const answer of asked.splice(0)) answer("now");
		const { failure } = await checking;
		expect(after, "fingerprints asked after the bound").toBe(0);
		expect(failure?.problems).toHaveLength(2);
		expect(failure?.problems.join("\n")).toMatch(
			/pnpm build failed in \/src\/repo while this/,
		);
	});

	it("holds a commit on no run retired while another project was asked", async () => {
		const lib = { ...RUN, root: "/src/repo/lib", command: "pnpm lint" };
		record(lib);
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitSays("judged");
		await gitAsked();
		// An edit or a clean verify retires the repository's run meanwhile.
		state.failedRuns.delete(RUN.root);
		await gitSays("judged");
		const { failure } = await checking;
		expect(failure?.problems).toEqual([
			expect.stringContaining("pnpm lint failed in /src/repo/lib"),
		]);
	});

	// Each project re-recorded while the other is asked about is judged
	// at its first ask, so only a bound per project across the check
	// ends it.
	it("asks no more about projects recorded again in turn past the bound", async () => {
		const lib = { ...RUN, root: "/src/repo/lib", command: "pnpm lint" };
		record(lib);
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		for (let turn = 0; turn < 6; turn++) {
			await gitAsked();
			record(turn % 2 === 0 ? { ...lib } : { ...RUN });
			await gitSays("judged");
		}
		await settled();
		expect(asked, "fingerprints asked past the bound").toHaveLength(0);
		const { failure } = await checking;
		expect(failure?.problems).toHaveLength(2);
		expect(failure?.problems.join("\n")).toMatch(
			/pnpm check failed in \/src\/repo while this/,
		);
	});

	// Each asks for a status of its project's tree; several at once only
	// load the disk the check waits on.
	it("asks git after one project's run at a time", async () => {
		record({ ...RUN, root: "/src/repo/lib", command: "pnpm lint" });
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitAsked();
		await settled();
		const atOnce = asked.length;
		await gitSays("judged");
		await gitSays("judged");
		const { failure } = await checking;
		expect(atOnce, "fingerprints asked at once").toBe(1);
		expect(failure?.problems).toHaveLength(2);
	});

	it("settles a commit's outcome without asking git about another repository's run", async () => {
		// Clean until the settle says otherwise, so one that never ran fails.
		state.outcome = "clean";
		const elsewhere = { ...NEXT, root: "/src/other" };
		record(elsewhere);
		const checking = commitCheck(state, { dir: "/src/repo" }, undefined);
		await gitSays("judged");
		await settled();
		const after = asked.length;
		// Answer any it asked, so a failing count fails rather than hangs.
		for (const answer of asked.splice(0)) answer("moved on");
		expect((await checking)?.problems).toHaveLength(1);
		expect(after, "fingerprints asked of the other repository").toBe(0);
		expect(state.failedRuns.get(elsewhere.root)).toBe(elsewhere);
		expect(state.outcome).toBe("failing");
	});

	it("holds nothing back for a run cleared while git answered", async () => {
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitAsked();
		state.failedRuns.clear();
		await gitSays("judged");
		const { failure } = await checking;
		expect(failure).toBeUndefined();
	});

	it("neither holds back nor forgets a run git gave no answer for", async () => {
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitSays(undefined);
		const { failure } = await checking;
		expect(failure).toBeUndefined();
		expect(repoRun()).toBe(RUN);
	});

	it("asks git once for the run its outcome rests on", async () => {
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitSays("judged");
		const { judged } = await checking;
		const settling = settle(state, judged);
		await settled();
		const after = asked.length;
		// Answer any it asked, so a failing count fails rather than hangs.
		for (const answer of asked.splice(0)) answer("judged");
		expect(await settling).toBe("failing");
		expect(after, "fingerprints asked after the check").toBe(0);
	});

	it("settles a commit's outcome from the answer its check had", async () => {
		state.outcome = "failing";
		const checking = commitCheck(state, { dir: "/src/repo" }, undefined);
		await gitSays("judged");
		await settled();
		const after = asked.length;
		// Answer any it asked, so a failing count fails rather than hangs.
		for (const answer of asked.splice(0)) answer("judged");
		expect((await checking)?.problems[0]).toContain("pnpm check failed");
		expect(after, "fingerprints asked after the check").toBe(0);
		expect(state.outcome).toBe("failing");
	});

	it("settles a commit's outcome clean once git says its run's tree moved on", async () => {
		state.outcome = "failing";
		const checking = commitCheck(state, { dir: "/src/repo" }, undefined);
		await gitSays("moved on");
		expect(await checking).toBeUndefined();
		expect(state.outcome).toBe("clean");
		expect(state.failedRuns.size, "runs left").toBe(0);
	});
});

describe("settling the outcome", () => {
	it("keeps a run recorded while git answered for the last", async () => {
		const settling = settle(state);
		await gitAsked();
		record(NEXT);
		await gitSays("moved on");
		expect(await settling).toBe("failing");
		expect(repoRun()).toBe(NEXT);
	});

	it("retires a run whose tree git says moved on", async () => {
		const settling = settle(state);
		await gitSays("moved on");
		expect(await settling).toBe("clean");
		expect(repoRun()).toBeUndefined();
	});

	it("retires only the runs whose trees moved on", async () => {
		const elsewhere = { ...RUN, root: "/src/other" };
		record(elsewhere);
		const settling = settle(state);
		await gitSays("moved on");
		await gitSays("judged");
		expect(await settling).toBe("failing");
		expect(repoRun()).toBeUndefined();
		expect(state.failedRuns.get(elsewhere.root)).toBe(elsewhere);
	});

	it("asks nothing of a project it is told to leave, and settles the rest", async () => {
		const elsewhere = { ...NEXT, root: "/src/other" };
		record(elsewhere);
		const settling = settle(state, [], undefined, new Set([RUN.root]));
		await gitSays("moved on");
		await settled();
		const after = asked.length;
		// Answer any it asked, so a failing count fails rather than hangs.
		for (const answer of asked.splice(0)) answer("moved on");
		expect(await settling).toBe("failing");
		expect(after, "fingerprints asked of the project left").toBe(0);
		expect(state.failedRuns.get(elsewhere.root)).toBeUndefined();
		expect(repoRun()).toBe(RUN);
	});

	it("retires a run whose root is gone", async () => {
		disk.there = false;
		const settling = settle(state);
		await gitSays(undefined);
		expect(await settling).toBe("clean");
		expect(repoRun()).toBeUndefined();
	});

	it("retires a run outside git once its root is gone", async () => {
		const { fingerprint: _, ...outside } = RUN;
		record(outside);
		disk.there = false;
		expect(await settle(state)).toBe("clean");
		expect(repoRun()).toBeUndefined();
	});

	it("keeps a run git gave no answer for", async () => {
		const settling = settle(state);
		await gitSays(undefined);
		expect(await settling).toBe("failing");
		expect(repoRun()).toBe(RUN);
	});
});
