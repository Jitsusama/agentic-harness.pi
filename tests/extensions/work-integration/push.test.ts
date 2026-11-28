/**
 * Publishing a branch through the work tool, against a bare origin:
 * what a first push says, that a push with nothing new says so
 * rather than claiming it published, and that a checkout's push check
 * from the package config runs first.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GLYPH } from "../../../extensions/work-integration/render.ts";
import { packageConfigPath } from "../../../lib/internal/paths.ts";
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

describe("push, in a checkout with a push check", () => {
	let savedConfig: string | undefined;

	beforeEach(() => {
		savedConfig = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = join(scratchDir(), "config");
	});

	afterEach(() => {
		if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = savedConfig;
	});

	/** A tree with an origin, whose checkout's push check runs `run`. */
	async function checkedTree(run: string): Promise<string> {
		const path = await treeWithOrigin();
		const gitDir = await git(
			path,
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		);
		const config = packageConfigPath();
		mkdirSync(dirname(config), { recursive: true });
		writeFileSync(
			config,
			JSON.stringify({
				version: 1,
				sections: { work: { pushChecks: { [gitDir]: { run } } } },
			}),
		);
		return path;
	}

	it("says the check passed before the push", async () => {
		await checkedTree("test -d .git");
		const pushed = await work({ action: "push" });
		expect(pushed.text).toBe(
			`${GLYPH.tree} topic published to origin after its push check passed (test -d .git), tracking it from now on.`,
		);
		expect(pushed.details).toMatchObject({ checked: "test -d .git" });
	});

	it("pushes nothing when the check fails", async () => {
		const path = await checkedTree("echo found a fault >&2; exit 3");
		const refused = await work({ action: "push" });
		expect(refused.text).toContain("exited 3");
		expect(refused.text).toContain("found a fault");
		await expect(git(path, "ls-remote", "origin", "topic")).resolves.toBe("");
	});
});
