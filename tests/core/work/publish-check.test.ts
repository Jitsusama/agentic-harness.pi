/**
 * A push runs its checkout's push check first.
 *
 * A check found failing only at the gate costs a push and a gate's
 * wait, and it did on 10 changes in the week to 27 November. So a
 * checkout whose owner names a check has it run before the push, and a
 * check that fails stops the push saying what to do. These are about
 * what runs and what is said, with the check faked, as `publish.test.ts`
 * fakes git.
 */

import { describe, expect, it } from "vitest";
import {
	EXIT_TIMED_OUT,
	type ExecResult,
} from "../../../lib/core/exec/index.ts";
import { createGitPublisher } from "../../../lib/core/work/publish.ts";
import type { PushCheck } from "../../../lib/core/work/push-checks.ts";
import { fakeExec, type Reply } from "../../support/fake-exec.ts";

const TREE = "/trees/topic";

const GIT_DIR = "/repos/world/.git";

const HEAD = "1111111111111111111111111111111111111111";

const CHECK: PushCheck = { run: "bash tools/fast-rules.sh", seconds: 300 };

/**
 * A tree on `topic`, tracking `origin/topic`, whose remote ref holds
 * `held`. The replies naming a ref come before `remote`, since the fake
 * matches fragments as substrings and `refs/remotes/` holds one.
 */
function treeHolding(held: string): Reply[] {
	return [
		{ when: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: "topic\n" },
		{ when: ["--git-common-dir"], stdout: `${GIT_DIR}\n` },
		{ when: ["rev-parse", "refs/heads/topic"], stdout: `${HEAD}\n` },
		{
			when: ["rev-parse", "refs/remotes/origin/topic"],
			stdout: `${held}\n`,
		},
		{
			when: ["config", "--get", "branch.topic.remote"],
			stdout: "origin\n",
		},
		{
			when: ["config", "--get", "branch.topic.merge"],
			stdout: "refs/heads/topic\n",
		},
		{
			when: ["remote.origin.fetch"],
			stdout: "+refs/heads/*:refs/remotes/origin/*\n",
		},
		{ when: ["remote"], stdout: "origin\n" },
		{ when: ["push"], stderr: "To github.com\n" },
	];
}

/** A tree with a commit its remote doesn't hold yet. */
const ahead = treeHolding("2222222222222222222222222222222222222222");

/** Checks that name `check` for the one git folder, recording what was asked. */
function checksOf(check: PushCheck | undefined) {
	const asked: string[] = [];
	return {
		asked,
		checks: async (gitDir: string) => {
			asked.push(gitDir);
			return gitDir === GIT_DIR ? check : undefined;
		},
	};
}

/** A check run that ends as `result` does, recording where it ran. */
function runEnding(result: Partial<ExecResult>) {
	const ran: { tree: string; check: PushCheck }[] = [];
	return {
		ran,
		runCheck: async (tree: string, check: PushCheck) => {
			ran.push({ tree, check });
			return { code: 0, stdout: "", stderr: "", ...result };
		},
	};
}

/** Whether git was asked to push. */
function pushed(calls: { args: string[] }[]): boolean {
	return calls.some((call) => call.args.includes("push"));
}

describe("a push with a push check", () => {
	it("pushes once the check passes, and says which check passed", async () => {
		const { exec, calls } = fakeExec(ahead);
		const { checks, asked } = checksOf(CHECK);
		const { runCheck, ran } = runEnding({ code: 0 });

		const outcome = await createGitPublisher({ exec, checks, runCheck }).push(
			TREE,
		);

		expect(asked).toEqual([GIT_DIR]);
		expect(ran).toEqual([{ tree: TREE, check: CHECK }]);
		expect(pushed(calls)).toBe(true);
		expect(outcome).toMatchObject({
			kind: "published",
			checked: "bash tools/fast-rules.sh",
		});
	});

	it("refuses when the check fails, runs no push, and says how to rerun it", async () => {
		const { exec, calls } = fakeExec(ahead);
		const { checks } = checksOf(CHECK);
		const said = Array.from({ length: 50 }, (_, at) => `line ${at + 1}`);
		const { runCheck } = runEnding({
			code: 2,
			stdout: `${said.slice(0, 45).join("\n")}\n`,
			stderr: `${said.slice(45).join("\n")}\n`,
		});

		const outcome = await createGitPublisher({ exec, checks, runCheck }).push(
			TREE,
		);

		expect(pushed(calls)).toBe(false);
		expect(outcome).toMatchObject({ kind: "refused", branch: "topic" });
		if (outcome.kind !== "refused") return;
		expect(outcome.reason).toContain("bash tools/fast-rules.sh");
		expect(outcome.reason).toContain("exited 2");
		expect(outcome.reason).toContain(
			"cd /trees/topic && bash tools/fast-rules.sh",
		);
		expect(outcome.reason, "its last 40 lines, stderr's too").toContain(
			said.slice(10).join("\n"),
		);
		expect(outcome.reason, "and none before them").not.toContain("line 10\n");
	});

	it("refuses when the check runs past its time, saying so", async () => {
		const { exec, calls } = fakeExec(ahead);
		const { checks } = checksOf({ run: "sleep 999", seconds: 5 });
		const { runCheck } = runEnding({ code: EXIT_TIMED_OUT });

		const outcome = await createGitPublisher({ exec, checks, runCheck }).push(
			TREE,
		);

		expect(pushed(calls)).toBe(false);
		expect(outcome).toMatchObject({ kind: "refused" });
		if (outcome.kind !== "refused") return;
		expect(outcome.reason).toContain("ran past its 5 seconds");
		expect(outcome.reason).not.toContain(`exited ${EXIT_TIMED_OUT}`);
	});

	it("pushes as it always did when the checkout names no check", async () => {
		const unchecked = fakeExec(ahead);
		const { checks } = checksOf(undefined);
		const { runCheck, ran } = runEnding({ code: 1 });
		const plain = fakeExec(ahead);

		const outcome = await createGitPublisher({
			exec: unchecked.exec,
			checks,
			runCheck,
		}).push(TREE);
		await createGitPublisher({ exec: plain.exec }).push(TREE);

		const push = (calls: { args: string[] }[]) =>
			calls.find((call) => call.args.includes("push"))?.args;
		expect(ran).toEqual([]);
		expect(push(unchecked.calls)).toEqual(push(plain.calls));
		expect(outcome).toMatchObject({ kind: "published" });
		expect(outcome).not.toHaveProperty("checked");
	});

	it("runs no check when the remote already holds what is pushed", async () => {
		// A push with nothing new costs nothing, and a check would make
		// it cost minutes.
		const { exec } = fakeExec([
			...treeHolding(HEAD).slice(0, -1),
			{ when: ["push"], stdout: "Everything up-to-date\n" },
		]);
		const { checks } = checksOf(CHECK);
		const { runCheck, ran } = runEnding({ code: 1 });

		const outcome = await createGitPublisher({ exec, checks, runCheck }).push(
			TREE,
		);

		expect(ran).toEqual([]);
		expect(outcome).toMatchObject({ kind: "already-there" });
	});
});
