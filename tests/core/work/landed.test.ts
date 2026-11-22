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
			// A binary is matched by its blob ids, as git's patch id matches it;
			// read as text, both images would read alike up to the NUL their
			// headers share.
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
		"takes another non-UTF-8 text beside the same log change for no landing",
		async () => {
			// Read as UTF-8, each unlike byte would come out as the same U+FFFD.
			await commit("log.md", "# Log\n", "start");
			await git(repo, "checkout", "-qb", "topic");
			await stage("a.txt", Buffer.from("caf\xe9\n", "latin1"));
			await commit("log.md", "# Log\n\n- Name the caf\n", "halted");
			await git(repo, "checkout", "-q", "main");
			await stage("a.txt", Buffer.from("caf\xe8\n", "latin1"));
			await commit("log.md", "# Log\n\n- Name the caf\n", "theirs");
			await git(repo, "update-ref", "REBASE_HEAD", "topic");

			expect(
				await landedAs(spawnExec(), repo, "main", ["log.md"]),
			).toBeUndefined();
		},
		REAL_GIT_MS,
	);

	it(
		"takes a log change that differs only past a NUL for no landing",
		async () => {
			// Read as text, the NUL is printed as it is, where it would cut each
			// commit's change short at the same place.
			await commit("log.md", "# Log\n", "start");
			await git(repo, "checkout", "-qb", "topic");
			await commit("log.md", "# Log\n\n- Same\0mine\n", "halted");
			await git(repo, "checkout", "-q", "main");
			await commit("log.md", "# Log\n\n- Same\0theirs\n", "theirs");
			await git(repo, "update-ref", "REBASE_HEAD", "topic");

			expect(
				await landedAs(spawnExec(), repo, "main", ["log.md"]),
			).toBeUndefined();
		},
		REAL_GIT_MS,
	);

	it(
		"takes a base's log change cut short by a NUL and a line like an id for no landing",
		async () => {
			// Only the base's side holds the NUL, and what follows it reads like a
			// commit's id, so its cut patch would read as the halted commit's.
			await commit("log.md", "# Log\n", "start");
			await git(repo, "checkout", "-qb", "topic");
			await commit("log.md", "# Log\n\n- Same\n", "halted");
			await git(repo, "checkout", "-q", "main");
			await commit("log.md", "# Log\n\n- Same\0beef\n- More\n", "theirs");
			await git(repo, "update-ref", "REBASE_HEAD", "topic");

			expect(
				await landedAs(spawnExec(), repo, "main", ["log.md"]),
			).toBeUndefined();
		},
		REAL_GIT_MS,
	);

	it(
		"reads past every merge base, not one",
		async () => {
			// Each side took the other, so there are two merge bases, and past one
			// alone lies the branch's own first try, which the halted commit only
			// makes again.
			await commit("log.md", "# Log\n", "start");
			await git(repo, "checkout", "-qb", "topic");
			await commit("log.md", "# Log\n\n- Again\n", "first");
			await commit("log.md", "# Log\n", "reverted");
			await git(repo, "checkout", "-q", "main");
			await commit("notes.md", "# Notes\n", "notes");
			const notes = await git(repo, "rev-parse", "HEAD");
			await git(repo, "merge", "-q", "--no-ff", "-m", "take topic", "topic");
			await git(repo, "checkout", "-q", "topic");
			await git(repo, "merge", "-q", "--no-ff", "-m", "take notes", notes);
			await commit("log.md", "# Log\n\n- Again\n", "halted");
			await git(repo, "update-ref", "REBASE_HEAD", "topic");
			const bases = await git(repo, "merge-base", "--all", "main", "topic");

			expect(bases.split("\n")).toHaveLength(2);
			expect(
				await landedAs(spawnExec(), repo, "main", ["log.md"]),
			).toBeUndefined();
		},
		REAL_GIT_MS,
	);

	it(
		"reads only the files in question, and a bounded count of the base's commits",
		async () => {
			// The walk of every commit the base gained is what the flag removes.
			await commit("log.md", "# Log\n", "start");
			await git(repo, "checkout", "-qb", "topic");
			await commit("log.md", "# Log\n\n## Mine\n", "halted");
			await git(repo, "checkout", "-q", "main");
			await commit("notes.md", "# Notes\n", "moves on");
			await git(repo, "cherry-pick", "topic");
			await git(repo, "update-ref", "REBASE_HEAD", "topic");
			const asked: string[][] = [];
			const real = spawnExec();
			const exec: Exec = (command, args) => {
				asked.push(args);
				return real(command, args);
			};

			await landedAs(exec, repo, "main", ["log.md"]);

			const walk = asked.find(
				(args) => args.includes("log") && !args.includes("--no-walk"),
			);
			expect(walk).toContain("--max-count=500");
			expect(walk?.slice(walk.indexOf("--"))).toEqual([
				"--",
				":(top,literal)log.md",
			]);
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
