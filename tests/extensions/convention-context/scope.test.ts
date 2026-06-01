import { describe, expect, it, vi } from "vitest";
import { isInsideWorkTree } from "../../../extensions/convention-context/scope.js";

type ExecResult = { stdout: string; stderr: string; code: number };

function fakeExec(result: ExecResult) {
	return vi.fn(async () => result);
}

describe("isInsideWorkTree", () => {
	it("returns true when git reports it is inside a work tree", async () => {
		const exec = fakeExec({ stdout: "true\n", stderr: "", code: 0 });
		expect(await isInsideWorkTree(exec, "/some/repo/src")).toBe(true);
		expect(exec).toHaveBeenCalledWith(
			"git",
			["rev-parse", "--is-inside-work-tree"],
			{ cwd: "/some/repo/src" },
		);
	});

	it("returns false when git exits non-zero (not a repo)", async () => {
		const exec = fakeExec({
			stdout: "",
			stderr: "fatal: not a git repository",
			code: 128,
		});
		expect(await isInsideWorkTree(exec, "/home/user")).toBe(false);
	});

	it("returns false when git reports false (inside the .git dir)", async () => {
		const exec = fakeExec({ stdout: "false\n", stderr: "", code: 0 });
		expect(await isInsideWorkTree(exec, "/repo/.git")).toBe(false);
	});

	it("returns false when the exec throws", async () => {
		const exec = vi.fn(async () => {
			throw new Error("git not found");
		});
		expect(await isInsideWorkTree(exec, "/anywhere")).toBe(false);
	});
});
