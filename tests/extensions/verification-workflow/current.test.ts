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

vi.mock("../../../extensions/verification-workflow/tree.ts", () => ({
	gitRoot: async () => "/src/repo",
	within: (root: string, path: string) => path.startsWith(root),
	treeFingerprint: () =>
		new Promise<string | undefined>((answer) => asked.push(answer)),
}));

/** Answer the oldest fingerprint still asked for with `print`. */
async function gitSays(print: string | undefined): Promise<void> {
	await vi.waitFor(() => expect(asked, "a git asked").not.toHaveLength(0));
	asked.shift()?.(print);
}

const RUN: FailedRun = {
	root: "/src/repo",
	command: "pnpm check",
	fingerprint: "judged",
};
const NEXT: FailedRun = { ...RUN, command: "pnpm test", fingerprint: "now" };

let state: VerificationState;

beforeEach(() => {
	asked.length = 0;
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

	it("keeps a run recorded while git answered for the last", async () => {
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
		state.failedRun = NEXT;
		await gitSays("moved on");
		const { failure } = await checking;
		expect(failure, "the new run, never asked about").toBeUndefined();
		expect(state.failedRun).toBe(NEXT);
	});

	it("holds nothing back for a run cleared while git answered", async () => {
		const checking = failureNow(state, { dir: "/src/repo" }, undefined);
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
		expect(await settle(state, judged)).toBe("failing");
		expect(asked, "fingerprints asked after the check").toHaveLength(0);
	});
});

describe("settling the outcome", () => {
	it("keeps a run recorded while git answered for the last", async () => {
		const settling = settle(state);
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

	it("keeps a run git gave no answer for", async () => {
		const settling = settle(state);
		await gitSays(undefined);
		expect(await settling).toBe("failing");
		expect(state.failedRun).toBe(RUN);
	});
});
