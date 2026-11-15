/**
 * Recording a commit and making a branch through the work tool: what
 * each refuses, and how it says what it did.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GLYPH } from "../../../extensions/work-integration/render.ts";
import { git } from "../../support/git-fixture.ts";
import { cut, work } from "./worked.ts";

describe("record", () => {
	it("refuses without a subject", async () => {
		await cut();
		expect((await work({ action: "record" })).text).toBe(
			`${GLYPH.refused} Say what the commit is for, as a subject. Conventional form: type(scope): subject.`,
		);
	});

	it("refuses a subject outside the commit format", async () => {
		const { path } = await cut();
		writeFileSync(join(path, "notes.txt"), "work\n");
		const answer = await work({ action: "record", subject: "Added notes." });
		expect(answer.text).toMatch(
			new RegExp(
				`^${GLYPH.refused} That message does not meet the commit format: `,
			),
		);
		expect(await git(path, "status", "--porcelain")).toContain("notes.txt");
	});

	it("refuses to record a clean tree", async () => {
		const { key } = await cut();
		expect(
			(await work({ action: "record", subject: "docs: add notes" })).text,
		).toBe(`${GLYPH.clean} Nothing to record in ${key}: the tree is clean.`);
	});

	it("commits what changed and names the commit", async () => {
		const { key, path } = await cut();
		writeFileSync(join(path, "notes.txt"), "work\n");
		const answer = await work({ action: "record", subject: "docs: add notes" });
		const commit = await git(path, "rev-parse", "HEAD");
		expect(answer.text).toBe(
			`${GLYPH.clean} Recorded 1 path in ${key} at ${commit.slice(0, 12)}.`,
		);
		expect(answer.details).toEqual({ ok: true, commit, recorded: 1 });
	});
});

describe("branch", () => {
	it("refuses without a name", async () => {
		await cut();
		expect((await work({ action: "branch" })).text).toBe(
			`${GLYPH.refused} Name the branch to make.`,
		);
	});

	it("makes the branch, names its head, and notes the naming convention", async () => {
		const { key, path } = await cut();
		const answer = await work({ action: "branch", name: "feature" });
		const commit = await git(path, "rev-parse", "HEAD");
		expect(answer.text).toContain(
			`${GLYPH.tree} ${key} is on feature, at ${commit.slice(0, 12)}.`,
		);
		expect(answer.text).toContain("Against the convention:");
		expect(answer.details).toEqual({ ok: true, branch: "feature", commit });
		expect(await git(path, "branch", "--show-current")).toBe("feature");
	});
});
