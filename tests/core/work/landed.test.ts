/**
 * When asking whether a halted commit already landed has nothing to ask.
 *
 * A landing's base side kept is asked through real rebases in
 * `rebase-live.test.ts`; these are what the match itself takes for one.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Exec, spawnExec } from "../../../lib/core/exec/index.ts";
import { keptLine, landedAs } from "../../../lib/core/work/landed.ts";
import {
	disposeRepo,
	freshRepo,
	git,
	REAL_GIT_MS,
} from "../../support/git-fixture.ts";

let repo: string;

beforeEach(async () => {
	repo = await freshRepo("landed");
});

afterEach(() => {
	disposeRepo(repo);
});

describe("saying a landing in a refusal", () => {
	it("names the files, the commit and where it landed", () => {
		expect(
			keptLine({ commit: "abc1234", as: "def5678", paths: ["a.md", "b.md"] }),
		).toBe(
			"a.md, b.md: abc1234 had already landed as def5678, so the base's side was kept before this.",
		);
	});
});

describe("asking where a halted commit landed", () => {
	it("answers nothing outside a halted replay", async () => {
		expect(
			await landedAs(spawnExec(), repo, "main", ["README.md"]),
		).toBeUndefined();
	});

	it("asks git nothing when no file is in question", async () => {
		// Without the files, the log would read every commit on the base.
		const asked: string[][] = [];
		const real = spawnExec();
		const exec: Exec = (command, args) => {
			asked.push(args);
			return real(command, args);
		};

		const landed = await landedAs(exec, repo, "main", []);

		expect(landed).toBeUndefined();
		expect(asked).toEqual([]);
	});

	it(
		"answers nothing when the halted commit didn't change the file",
		async () => {
			// As for a file the base renamed, in conflict under the base's name:
			// an ancestor that changed it, and landed, is not the halted commit
			// landing.
			await commit("log.md", "# Log\n", "start");
			await git(repo, "checkout", "-qb", "topic");
			await commit("log.md", "# Log\n\n## Mine\n", "mine");
			await commit("other.md", "# Other\n", "halted");
			await git(repo, "checkout", "-q", "main");
			await commit("notes.md", "# Notes\n", "moves on");
			await git(repo, "cherry-pick", "topic~1");
			await git(repo, "update-ref", "REBASE_HEAD", "topic");

			expect(
				await landedAs(spawnExec(), repo, "main", ["log.md"]),
			).toBeUndefined();
		},
		REAL_GIT_MS,
	);

	it(
		"names only the files the halted commit changed",
		async () => {
			// Asked of a file it never touched too, as of one the base renamed:
			// that file's branch side never landed, so it is left to the settler.
			await commit("log.md", "# Log\n", "start");
			await git(repo, "checkout", "-qb", "topic");
			await commit("log.md", "# Log\n\n## Mine\n", "halted");
			await git(repo, "checkout", "-q", "main");
			await commit("new.md", "# New\n", "moves on");
			await git(repo, "cherry-pick", "topic");
			const as = await git(repo, "rev-parse", "--short", "HEAD");
			await git(repo, "update-ref", "REBASE_HEAD", "topic");

			expect(
				await landedAs(spawnExec(), repo, "main", ["new.md", "log.md"]),
			).toMatchObject({ as, paths: ["log.md"] });
		},
		REAL_GIT_MS,
	);

	it(
		"takes another commit making the same log change for no landing",
		async () => {
			// Two fixes that each add the same changelog bullet: alike in the log,
			// but the branch's own fix never landed.
			await commit("log.md", "# Log\n", "start");
			await git(repo, "checkout", "-qb", "topic");
			writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
			await git(repo, "add", "a.ts");
			await commit("log.md", "# Log\n\n- Fix a typo\n", "halted");
			await git(repo, "checkout", "-q", "main");
			writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
			await git(repo, "add", "b.ts");
			await commit("log.md", "# Log\n\n- Fix a typo\n", "theirs");
			await git(repo, "update-ref", "REBASE_HEAD", "topic");

			expect(
				await landedAs(spawnExec(), repo, "main", ["log.md"]),
			).toBeUndefined();
		},
		REAL_GIT_MS,
	);

	it(
		"takes another binary beside the same log change for no landing",
		async () => {
			// Read as text, both images would end at the NUL their headers share,
			// and the commits would read the same from there on.
			await commit("log.md", "# Log\n", "start");
			await git(repo, "checkout", "-qb", "topic");
			await stage("shot.png", image("mine"));
			await commit("log.md", "# Log\n\n- Add a shot\n", "halted");
			await git(repo, "checkout", "-q", "main");
			await stage("shot.png", image("theirs"));
			await commit("log.md", "# Log\n\n- Add a shot\n", "theirs");
			await git(repo, "update-ref", "REBASE_HEAD", "topic");

			expect(
				await landedAs(spawnExec(), repo, "main", ["log.md"]),
			).toBeUndefined();
		},
		REAL_GIT_MS,
	);

	it(
		"finds a landing whose commit changed code and a binary too",
		async () => {
			await commit("log.md", "# Log\n", "start");
			await git(repo, "checkout", "-qb", "topic");
			await stage("a.ts", "export const a = 1;\n");
			await stage("shot.png", image("mine"));
			await commit("log.md", "# Log\n\n- Add a shot\n", "halted");
			await git(repo, "checkout", "-q", "main");
			await commit("notes.md", "# Notes\n", "notes");
			await git(repo, "cherry-pick", "topic");
			const as = (await git(repo, "rev-parse", "--short", "HEAD")).trim();
			await git(repo, "update-ref", "REBASE_HEAD", "topic");

			expect(
				await landedAs(spawnExec(), repo, "main", ["log.md"]),
			).toMatchObject({ as, paths: ["log.md"] });
		},
		REAL_GIT_MS,
	);
});

/** A PNG's header, NUL and all, then `rest`. */
function image(rest: string): Buffer {
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]),
		Buffer.from(rest),
	]);
}

/** Write a file in the repo and stage it, for the next commit. */
async function stage(path: string, content: string | Buffer) {
	writeFileSync(join(repo, path), content);
	await git(repo, "add", path);
}

/** Write a file in the repo and commit it alone. */
async function commit(path: string, text: string, subject: string) {
	writeFileSync(join(repo, path), text);
	await git(repo, "add", path);
	await git(repo, "commit", "-q", "-m", subject);
}
