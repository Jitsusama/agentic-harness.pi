/** Verify follows each runner's folder and last relative edit. */
import { afterEach, describe, expect, it, vi } from "vitest";
import verificationWorkflow from "../../../extensions/verification-workflow/index.ts";
import { extensionRunner } from "../../support/extension-runner.ts";

const runVerify = vi.hoisted(() =>
	vi.fn(async () => ({ ok: true, command: "check", output: "clean" })),
);
vi.mock("../../../lib/core/verify/run.ts", () => ({ runVerify }));
vi.mock("../../../lib/core/verify/project.ts", () => ({
	findProject: () => undefined,
}));
const runners: ReturnType<typeof extensionRunner>[] = [];
afterEach(async () => {
	for (const session of runners.splice(0)) await session.stop();
	runVerify.mockClear();
});

describe("verify with two runners in a process", () => {
	it("uses each conversation's cwd, even after the other edits and quits", async () => {
		const a = extensionRunner(verificationWorkflow, "/work/a");
		const b = extensionRunner(verificationWorkflow, "/work/b");
		runners.push(a, b);
		await a.start();
		await b.start();
		await a.call("verify", {});
		expect(runVerify).toHaveBeenLastCalledWith({ cwd: "/work/a" });
		await b.call("verify", { path: "src/b.ts" });
		expect(runVerify).toHaveBeenLastCalledWith({ cwd: "/work/b/src" });
		await a.runner.emitToolResult({
			type: "tool_result",
			toolCallId: "edit",
			toolName: "edit",
			input: { path: "src/a.ts" },
			content: [],
			details: undefined,
			isError: false,
		});
		await b.runner.emitToolResult({
			type: "tool_result",
			toolCallId: "edit",
			toolName: "edit",
			input: { path: "other/b.ts" },
			content: [],
			details: undefined,
			isError: false,
		});
		await b.stop();
		await a.call("verify", {});
		expect(runVerify).toHaveBeenLastCalledWith({ cwd: "/work/a/src" });
		expect(a.errors).toEqual([]);
		expect(b.errors).toEqual([]);
	});
});
