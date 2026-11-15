/**
 * Publishing a branch through the work tool, against a bare origin:
 * what a first push says, and that a push with nothing new says so
 * rather than claiming it published.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GLYPH } from "../../../extensions/work-integration/render.ts";
import { git } from "../../support/git-fixture.ts";
import { cut, scratchDir, work } from "./worked.ts";

/** A tree whose branch has a commit of its own, and an empty bare origin. */
async function treeWithOrigin(): Promise<string> {
	const { path } = await cut();
	const origin = join(scratchDir(), "origin.git");
	await git(scratchDir(), "init", "-q", "--bare", origin);
	await git(path, "remote", "add", "origin", origin);
	await git(path, "commit", "-q", "--allow-empty", "-m", "work");
	return path;
}

describe("push", () => {
	it("publishes a new branch and tracks it", async () => {
		const path = await treeWithOrigin();
		expect(await work({ action: "push" })).toEqual({
			text: `${GLYPH.tree} topic published to origin, tracking it from now on.`,
			details: { ok: true, branch: "topic", published: true },
		});
		expect(await git(path, "rev-parse", "origin/topic")).toBe(
			await git(path, "rev-parse", "HEAD"),
		);
	});

	it("says the remote already has it when nothing is new", async () => {
		await treeWithOrigin();
		await work({ action: "push" });
		expect(await work({ action: "push" })).toEqual({
			text: `${GLYPH.clean} origin/topic already has this. Nothing to publish.`,
			details: { ok: true, branch: "topic", published: false },
		});
	});
});
