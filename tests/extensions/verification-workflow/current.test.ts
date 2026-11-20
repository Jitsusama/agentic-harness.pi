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

vi.mock("../../../extensions/verification-workflow/tree.ts", () => ({
	gitRoot: async () => "/src/repo",
	within: (root: string, path: string) => path.startsWith(root),
	present: async () => disk.there,
	treeFingerprint: () =>
		new Promise<string | undefined>((answer) => asked.push(answer)),
}));

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

/** Let whatever is ready run, before counting what it asked. */
async function settled(): Promise<void> {
	// One macrotask: every promise already answered has run by then.
	await new Promise((done) => setTimeout(done, 0));
}

beforeEach(() => {
	asked.length = 0;
	disk.there = true;
	state = createVerificationState();
	state.failedRun = RUN;
});

describe("a commit's check", () => {
	it("holds back a commit on a run whose tree git says is the same", async () => {
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitSays("judged");
		const { failure } = await checking;
		expect(failure?.problems[0]).toContain("pnpm check failed");
	});

	it("asks again for a run recorded while git answered for the last", async () => {
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitAsked();
		state.failedRun = NEXT;
		await gitSays("moved on");
		await gitSays("now");
		const { failure, judged } = await checking;
		expect(failure?.problems[0]).toContain("pnpm test failed");
		expect(judged?.run).toBe(NEXT);
		expect(state.failedRun).toBe(NEXT);
	});

	it("neither holds back nor retires a run git said nothing of, asking nothing", async () => {
		const unsaid: FailedRun = { ...RUN, fingerprint: null };
		state.failedRun = unsaid;
		const { failure } = await failureNow(
			state,
			{ dir: "/src/repo" },
			undefined,
		);
		expect(failure).toBeUndefined();
		expect(state.failedRun).toBe(unsaid);
		expect(asked, "fingerprints asked").toHaveLength(0);
	});

	// Three asks bound a check that verifies keep overtaking; the newest
	// is left for the next ask rather than chased.
	it("leaves the newest run for the next ask after three recorded meanwhile", async () => {
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		const newest = { ...NEXT, command: "pnpm lint" };
		for (const next of [NEXT, { ...NEXT }, newest]) {
			await gitAsked();
			state.failedRun = next;
			await gitSays("now");
		}
		const { failure, judged } = await checking;
		expect(failure).toBeUndefined();
		expect(asked, "fingerprints still asked").toHaveLength(0);
		expect(judged?.run).not.toBe(newest);
		expect(state.failedRun).toBe(newest);
	});

	it("settles a commit's outcome past the bound without asking git again", async () => {
		state.outcome = "failing";
		const checking = commitCheck(state, { dir: "/src/repo" }, undefined);
		const newest = { ...NEXT, command: "pnpm lint" };
		for (const next of [NEXT, { ...NEXT }, newest]) {
			await gitAsked();
			state.failedRun = next;
			await gitSays("now");
		}
		await settled();
		const after = asked.length;
		// Answer any it asked, so a failing count fails rather than hangs.
		for (const answer of asked.splice(0)) answer("now");
		expect(await checking).toBeUndefined();
		expect(after, "fingerprints asked after the bound").toBe(0);
		expect(state.outcome).toBe("failing");
		expect(state.failedRun).toBe(newest);
	});

	it("holds nothing back for a run cleared while git answered", async () => {
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitAsked();
		state.failedRun = undefined;
		await gitSays("judged");
		const { failure } = await checking;
		expect(failure).toBeUndefined();
	});

	it("neither holds back nor forgets a run git gave no answer for", async () => {
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		await gitSays(undefined);
		const { failure } = await checking;
		expect(failure).toBeUndefined();
		expect(state.failedRun).toBe(RUN);
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
});

describe("settling the outcome", () => {
	it("keeps a run recorded while git answered for the last", async () => {
		const settling = settle(state);
		await gitAsked();
		state.failedRun = NEXT;
		await gitSays("moved on");
		expect(await settling).toBe("failing");
		expect(state.failedRun).toBe(NEXT);
	});

	it("retires a run whose tree git says moved on", async () => {
		const settling = settle(state);
		await gitSays("moved on");
		expect(await settling).toBe("clean");
		expect(state.failedRun).toBeUndefined();
	});

	it("retires a run whose root is gone", async () => {
		disk.there = false;
		const settling = settle(state);
		await gitSays(undefined);
		expect(await settling).toBe("clean");
		expect(state.failedRun).toBeUndefined();
	});

	it("retires a run git said nothing of once its root is gone", async () => {
		state.failedRun = { ...RUN, fingerprint: null };
		disk.there = false;
		expect(await settle(state)).toBe("clean");
		expect(state.failedRun).toBeUndefined();
	});

	it("retires a run outside git once its root is gone", async () => {
		const { fingerprint: _, ...outside } = RUN;
		state.failedRun = outside;
		disk.there = false;
		expect(await settle(state)).toBe("clean");
		expect(state.failedRun).toBeUndefined();
	});

	it("keeps a run git gave no answer for", async () => {
		const settling = settle(state);
		await gitSays(undefined);
		expect(await settling).toBe("failing");
		expect(state.failedRun).toBe(RUN);
	});
});
