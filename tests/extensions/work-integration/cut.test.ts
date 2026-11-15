/**
 * Cutting a worktree or pinning a snapshot through the work tool: what
 * it refuses, and how it names what it cut.
 */

import { describe, expect, it } from "vitest";
import { GLYPH } from "../../../extensions/work-integration/render.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { git } from "../../support/git-fixture.ts";
import { checkout, REPO, work } from "./worked.ts";

describe("cutting a tree", () => {
	it("refuses without a repo to cut from", async () => {
		const answer = await work({ action: "tree", purpose: "x", branch: "x" });
		expect(answer.text).toBe(
			`${GLYPH.refused} Name the repo to cut from, as a repo key like github:Shopify/world.`,
		);
		expect(answer.details.ok).not.toBe(true);
	});

	it("refuses without a purpose to name it by", async () => {
		const answer = await work({ action: "tree", repo: REPO, branch: "x" });
		expect(answer.text).toMatch(
			new RegExp(`^${GLYPH.refused} Say what the tree is for`),
		);
	});

	it("names the worktree, where it is, what cut it and its head", async () => {
		const answer = await work({
			action: "tree",
			repo: REPO,
			purpose: "fix-410",
			branch: "fix-410",
		});
		const { key, path } = answer.details;
		if (typeof path !== "string") throw new Error("no path");
		const head = await git(path, "rev-parse", "--short=12", "HEAD");
		expect(answer.text).toBe(
			`${GLYPH.tree} ${key}\n   ${displayPath(path)} · copying · at ${head}`,
		);
		expect(answer.details).toEqual({ ok: true, path, key });
		expect(await git(path, "branch", "--show-current")).toBe("fix-410");
	});
});

describe("pinning a snapshot", () => {
	it("refuses without a commit to pin", async () => {
		const answer = await work({ action: "snapshot", repo: REPO, purpose: "x" });
		expect(answer.text).toMatch(
			new RegExp(`^${GLYPH.refused} A snapshot needs a commit to pin.`),
		);
	});

	it("names the snapshot with the commit it is pinned at", async () => {
		const commit = await git(checkout(), "rev-parse", "HEAD");
		const answer = await work({
			action: "snapshot",
			repo: REPO,
			purpose: "read-it",
			commit,
		});
		const { key, path } = answer.details;
		if (typeof path !== "string") throw new Error("no path");
		expect(answer.text).toBe(
			`${GLYPH.snapshot} ${key}\n   ${displayPath(path)} · copying · at ${commit.slice(0, 12)}`,
		);
		expect(answer.details).toEqual({ ok: true, path, key });
	});
});
