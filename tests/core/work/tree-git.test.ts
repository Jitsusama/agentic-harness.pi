/**
 * Asking git about one tree: what the commits, rebases, stacks and
 * carries read before they act.
 */

import { describe, expect, it } from "vitest";
import { ask, conflictedIn } from "../../../lib/core/work/tree-git.ts";
import { fakeExec } from "../../support/fake-exec.ts";

describe("asking git about a tree", () => {
	it("asks in the tree it names, and reads the answer trimmed", async () => {
		const { exec, calls } = fakeExec([
			{ when: ["rev-parse"], stdout: "abc123\n" },
		]);

		expect(await ask(exec, "/tree", ["rev-parse", "HEAD"])).toBe("abc123");
		expect(calls).toEqual([
			{ command: "git", args: ["-C", "/tree", "rev-parse", "HEAD"] },
		]);
	});

	it("reads a failure, or saying nothing, as no answer", async () => {
		const { exec } = fakeExec([
			{ when: ["config"], code: 1, stdout: "ignored\n" },
			{ when: ["status"], stdout: "  \n" },
		]);

		expect(await ask(exec, "/tree", ["config", "x.y"])).toBeUndefined();
		expect(await ask(exec, "/tree", ["status"])).toBeUndefined();
	});

	it("names the paths git left unmerged, and none when it names none", async () => {
		const unmerged = fakeExec([
			{ when: ["--diff-filter=U"], stdout: "a.ts\nlib/b.ts\n" },
		]);
		const clean = fakeExec([{ when: ["--diff-filter=U"], stdout: "" }]);

		expect(await conflictedIn(unmerged.exec, "/tree")).toEqual([
			"a.ts",
			"lib/b.ts",
		]);
		expect(unmerged.calls[0]?.args).toEqual([
			"-C",
			"/tree",
			"diff",
			"--name-only",
			"--diff-filter=U",
		]);
		expect(await conflictedIn(clean.exec, "/tree")).toEqual([]);
	});
});
