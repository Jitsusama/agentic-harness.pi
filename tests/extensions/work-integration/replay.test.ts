/**
 * Replaying a branch through the work tool: what it refuses, and how
 * it says a replay that had nothing to do or only moved the branch up.
 */

import { describe, expect, it } from "vitest";
import { GLYPH } from "../../../extensions/work-integration/render.ts";
import { git } from "../../support/git-fixture.ts";
import { cut, work } from "./worked.ts";

describe("rebase", () => {
	it("refuses without a base to replay onto", async () => {
		await cut();
		expect((await work({ action: "rebase" })).text).toBe(
			`${GLYPH.refused} Name what to replay onto, with onto. A rebase has no sensible default: replaying onto the wrong base rewrites every commit on the branch.`,
		);
	});

	it("says a branch already on its base has nothing to replay", async () => {
		await cut();
		expect(await work({ action: "rebase", onto: "main" })).toEqual({
			text: `${GLYPH.clean} topic is already on top of main. Nothing to replay.`,
			details: { ok: true, branch: "topic", replayed: 0 },
		});
	});

	it("says a branch with no commits of its own was moved up", async () => {
		const { path } = await cut();
		await git(path, "checkout", "-q", "main");
		await git(path, "commit", "-q", "--allow-empty", "-m", "moved on");
		await git(path, "checkout", "-q", "topic");
		const answer = await work({ action: "rebase", onto: "main" });
		expect(answer.text).toContain(
			`${GLYPH.tree} topic moved up to main, with no commits of its own to replay.`,
		);
		expect(answer.details).toEqual({ ok: true, branch: "topic", replayed: 0 });
	});

	it("says a replay with no remote trunk to judge by took every commit", async () => {
		const { path } = await cut();
		await git(path, "commit", "-q", "--allow-empty", "-m", "mine");
		await git(path, "checkout", "-q", "main");
		await git(path, "commit", "-q", "--allow-empty", "-m", "moved on");
		await git(path, "checkout", "-q", "topic");
		const answer = await work({ action: "rebase", onto: "main" });
		expect(answer.text).toContain(
			"No remote trunk here to judge by, so every commit main lacks was replayed, any of trunk's among them included.",
		);
	});
});

describe("resume and abandon", () => {
	it("refuses when no replay has stopped", async () => {
		await cut();
		for (const action of ["resume", "abandon"]) {
			const answer = await work({ action });
			expect(answer.text, action).toMatch(new RegExp(`^${GLYPH.refused} `));
			expect(answer.details.ok, action).not.toBe(true);
		}
	});
});
