/**
 * Cutting a carried tree from the person's checkout and taking it out
 * again, through real git: what the cut didn't make is never touched,
 * and a branch is put back only where it still stands where settling
 * left it.
 */

import {
	chmodSync,
	existsSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import { cutFrom, uncut } from "../../../../lib/internal/carry/cut.ts";
import { git } from "../../../support/git-fixture.ts";
import {
	bareOrigin,
	cloneAt,
	commit,
	exec,
	folder,
	removeAll,
} from "./support/machines.ts";

const made: string[] = [];
afterEach(() => removeAll(made));

/** The person's checkout, with `topic` one commit past main and `spare` another. */
async function checkout() {
	const origin = await bareOrigin(made);
	const path = await cloneAt(origin, join(folder(made, "src"), "app"));
	const main = await git(path, "rev-parse", "HEAD");
	await git(path, "checkout", "-q", "-b", "topic");
	const topic = await commit(path, "work.txt", "the person's\n");
	await git(path, "checkout", "-q", "-b", "spare", main);
	const spare = await commit(path, "spare.txt", "the person's too\n");
	await git(path, "checkout", "-q", "main");
	return { path, gitDir: join(path, ".git"), main, topic, spare };
}

/** A tree cut at a fresh path for `branch`, as an arrival cuts one. */
async function cut(gitDir: string, name: string, branch = "topic") {
	const at = join(folder(made, "trees"), name);
	const one = await cutFrom(exec, gitDir, at, branch);
	if ("why" in one) throw new Error(one.why);
	return { at, cut: one };
}

/** Where `branch` stands in the checkout at `path`, or none. */
async function standing(path: string, branch: string) {
	const said = await exec("git", [
		"-C",
		path,
		"rev-parse",
		"--verify",
		"-q",
		`refs/heads/${branch}`,
	]);
	return said.code === 0 ? said.stdout.trim() : undefined;
}

/** `exec`, but answering as `answer` for any git call naming `step`. */
function failing(step: string, answer: { code: number; stderr: string }): Exec {
	return (command, args) =>
		args.includes(step)
			? Promise.resolve({ ...answer, stdout: "" })
			: exec(command, args);
}

describe("cutting a tree from the person's checkout", () => {
	it("takes out nothing where git refused the cut", async () => {
		const { gitDir, path, topic } = await checkout();
		const { at } = await cut(gitDir, "taken");

		const again = await cutFrom(exec, gitDir, at, "topic");

		expect(again).toMatchObject({ why: expect.stringMatching(/couldn't cut/) });
		expect(existsSync(join(at, ".git")), "the tree already there stays").toBe(
			true,
		);
		expect(readdirSync(join(gitDir, "worktrees"))).toHaveLength(1);
		expect(await standing(path, "topic")).toBe(topic);
	});

	it.each([
		["git fails", { code: 128, stderr: "fatal: broken\n" }, /fatal: broken$/],
		["git never ran, or was killed", { code: 1, stderr: "" }, /answered 1$/],
	])("refuses the cut where %s listing the branch", async (_, answer, why) => {
		const { gitDir } = await checkout();
		const at = join(folder(made, "trees"), "unread");

		const refused = await cutFrom(
			failing("for-each-ref", answer),
			gitDir,
			at,
			"topic",
		);

		expect(refused).toMatchObject({
			why: expect.stringMatching(/^git couldn't read topic /),
		});
		expect("why" in refused ? refused.why : "").toMatch(why);
		expect(existsSync(at), "nothing was cut").toBe(false);
	});

	it("refuses the cut where the branch's ref can't be read", async () => {
		const { gitDir } = await checkout();
		writeFileSync(join(gitDir, "refs", "heads", "topic"), "not a sha\n");
		const at = join(folder(made, "trees"), "broken");

		const refused = await cutFrom(exec, gitDir, at, "topic");

		expect(refused).toMatchObject({
			why: expect.stringMatching(/couldn't read topic .*broken ref/),
		});
		expect(existsSync(at), `${at} isn't there`).toBe(false);
	});

	it.skipIf(process.getuid?.() === 0)(
		"refuses the cut where the branch's own ref can't be opened",
		async () => {
			const { gitDir } = await checkout();
			const ref = join(gitDir, "refs", "heads", "topic");
			const at = join(folder(made, "trees"), "unopened");
			chmodSync(ref, 0o000);
			let refused: Awaited<ReturnType<typeof cutFrom>>;
			try {
				refused = await cutFrom(exec, gitDir, at, "topic");
			} finally {
				chmodSync(ref, 0o644);
			}

			expect(refused).toMatchObject({
				why: expect.stringMatching(/^git couldn't read topic /),
			});
			expect(existsSync(at), "nothing was cut").toBe(false);
		},
	);

	it.skipIf(process.getuid?.() === 0)(
		"refuses the cut where the branches' folder can't be read, though git lists nothing and says nothing",
		async () => {
			const { gitDir } = await checkout();
			const heads = join(gitDir, "refs", "heads");
			const at = join(folder(made, "trees"), "unlisted");
			chmodSync(heads, 0o000);
			let refused: Awaited<ReturnType<typeof cutFrom>>;
			try {
				refused = await cutFrom(exec, gitDir, at, "topic");
			} finally {
				chmodSync(heads, 0o755);
			}

			expect(refused).toMatchObject({
				why: expect.stringMatching(/^git couldn't read topic /),
			});
			expect(existsSync(at), "nothing was cut").toBe(false);
		},
	);

	it("cuts beside a broken ref of another branch whose name begins with its own", async () => {
		const { gitDir, topic } = await checkout();
		writeFileSync(join(gitDir, "refs", "heads", "topic-old"), "not a sha\n");

		const { cut: beside } = await cut(gitDir, "beside-broken");

		expect(beside).toEqual({ checkout: gitDir, before: topic });
	});

	it("cuts a branch that isn't there beside a broken ref of another", async () => {
		const { gitDir } = await checkout();
		writeFileSync(join(gitDir, "refs", "heads", "fresh-old"), "not a sha\n");

		const { cut: fresh } = await cut(gitDir, "fresh-beside-broken", "fresh");

		expect(fresh).toEqual({ checkout: gitDir, before: undefined });
	});

	it.each([
		["it stands", "topic"],
		["it isn't there", "fresh"],
	])(
		"cuts though git warns of something else while listing the branch, where %s",
		async (_, branch) => {
			const { gitDir, topic } = await checkout();
			const warned: Exec = async (command, args) => {
				const done = await exec(command, args);
				return args.includes("for-each-ref")
					? {
							...done,
							stderr: `warning: unable to access '/home/x/.config/git/attributes': Permission denied\n${done.stderr}`,
						}
					: done;
			};
			const at = join(folder(made, "trees"), `warned-${branch}`);

			const one = await cutFrom(warned, gitDir, at, branch);

			expect(one).toEqual({
				checkout: gitDir,
				before: branch === "topic" ? topic : undefined,
			});
		},
	);

	it.each([["a git that never ran", { code: 1, stderr: "" }, /answered 1$/]])(
		"refuses the cut of a branch it doesn't list where %s can't say it is missing",
		async (_, answer, why) => {
			const { gitDir } = await checkout();
			const at = join(folder(made, "trees"), "unsure");

			const refused = await cutFrom(
				failing("show-ref", answer),
				gitDir,
				at,
				"fresh",
			);

			expect(refused).toMatchObject({
				why: expect.stringMatching(/^git couldn't read fresh /),
			});
			expect("why" in refused ? refused.why : "").toMatch(why);
			expect(existsSync(at), "nothing was cut").toBe(false);
		},
	);

	it("reads a branch git lists whole without it as none", async () => {
		const { gitDir } = await checkout();

		const { cut: fresh } = await cut(gitDir, "absent", "fresh");

		expect(fresh).toEqual({ checkout: gitDir, before: undefined });
	});
});

describe("taking a cut tree out again", () => {
	it("puts the branch back where settling moved it", async () => {
		const { gitDir, path, main, topic } = await checkout();
		const { at, cut: one } = await cut(gitDir, "moved");
		await git(path, "update-ref", "refs/heads/topic", main);

		const left = await uncut(exec, one, at, "topic", main);

		expect(left).toBeUndefined();
		expect(await standing(path, "topic")).toBe(topic);
		expect(existsSync(at), `${at} isn't there`).toBe(false);
	});

	it("takes out a branch settling made", async () => {
		const { gitDir, path, main } = await checkout();
		const { at, cut: one } = await cut(gitDir, "made", "fresh");
		await git(path, "update-ref", "refs/heads/fresh", main);

		expect(await uncut(exec, one, at, "fresh", main)).toBeUndefined();
		expect(await standing(path, "fresh")).toBeUndefined();
	});

	it("leaves a branch settling never moved, though another brought it to the head", async () => {
		const { gitDir, path, main } = await checkout();
		const { at, cut: one } = await cut(gitDir, "unsettled");
		await git(path, "update-ref", "refs/heads/topic", main);

		expect(await uncut(exec, one, at, "topic", undefined)).toBeUndefined();
		expect(await standing(path, "topic")).toBe(main);
		expect(existsSync(at), `${at} isn't there`).toBe(false);
	});

	it("leaves a branch something else moved meanwhile", async () => {
		const { gitDir, path, main, topic } = await checkout();
		const { at, cut: one } = await cut(gitDir, "raced");
		await git(path, "checkout", "-q", "topic");
		const theirs = await commit(path, "more.txt", "the person's again\n");
		expect(theirs).not.toBe(topic);

		expect(await uncut(exec, one, at, "topic", main)).toBeUndefined();
		expect(await standing(path, "topic"), "their new commit stays").toBe(
			theirs,
		);
	});

	it("leaves a branch moved between reading it and putting it back", async () => {
		const { gitDir, path, main, spare } = await checkout();
		const { at, cut: one } = await cut(gitDir, "racing");
		await git(path, "update-ref", "refs/heads/topic", main);
		const racing: Exec = async (command, args) => {
			if (args.includes("update-ref")) {
				await git(path, "update-ref", "refs/heads/topic", spare);
			}
			return exec(command, args);
		};

		const left = await uncut(racing, one, at, "topic", main);

		expect(left).toMatch(/^its branch topic couldn't be put back in /);
		expect(await standing(path, "topic"), "the move stays").toBe(spare);
	});

	it("leaves a branch it can't read, and says so", async () => {
		const { gitDir, path, main } = await checkout();
		const { at, cut: one } = await cut(gitDir, "unread");
		await git(path, "update-ref", "refs/heads/topic", main);

		const left = await uncut(
			failing("for-each-ref", { code: 1, stderr: "" }),
			one,
			at,
			"topic",
			main,
		);

		expect(left).toMatch(/couldn't be read .*so it was left/);
		expect(await standing(path, "topic"), "left, not deleted").toBe(main);
		expect(existsSync(at), "the tree still goes").toBe(false);
	});

	it("takes out the tree and its own entry where git can't remove it", async () => {
		const { gitDir, path, main, topic } = await checkout();
		const { at, cut: one } = await cut(gitDir, "stuck");
		await git(path, "update-ref", "refs/heads/topic", main);
		const refusing = failing("remove", { code: 128, stderr: "fatal: no\n" });

		expect(await uncut(refusing, one, at, "topic", main)).toBeUndefined();
		expect(existsSync(at), `${at} isn't there`).toBe(false);
		expect(readdirSync(join(gitDir, "worktrees"))).toEqual([]);
		expect(await standing(path, "topic")).toBe(topic);
	});

	it.skipIf(process.getuid?.() === 0)(
		"leaves the branch of a tree that couldn't be removed, though it can't be seen",
		async () => {
			const { gitDir, path, main } = await checkout();
			const { at, cut: one } = await cut(gitDir, "hidden");
			await git(path, "update-ref", "refs/heads/topic", main);
			const refusing = failing("remove", {
				code: 128,
				stderr: "fatal: no\n",
			});
			// Its folder can't be read, so the tree can't be seen, nor removed.
			const parent = join(at, "..");
			chmodSync(parent, 0o000);
			let left: string | undefined;
			try {
				left = await uncut(refusing, one, at, "topic", main);
			} finally {
				chmodSync(parent, 0o755);
			}

			expect(left).toMatch(/, so its branch topic was left where it stands$/);
			expect(existsSync(at), "the tree is still there").toBe(true);
			expect(await standing(path, "topic"), "so its branch stays").toBe(main);
		},
	);

	it("leaves another tree's entry where its .git is a link to that tree's own", async () => {
		const { gitDir, path, main } = await checkout();
		const { at, cut: one } = await cut(gitDir, "linked");
		const other = await cut(gitDir, "other", "spare");
		const theirs = await git(other.at, "rev-parse", "--absolute-git-dir");
		rmSync(join(at, ".git"));
		symlinkSync(join(other.at, ".git"), join(at, ".git"));
		await git(path, "update-ref", "refs/heads/topic", main);
		const refusing = failing("remove", { code: 128, stderr: "fatal: no\n" });

		const left = await uncut(refusing, one, at, "topic", main);

		expect(left).toMatch(/^git's entry for the tree cut at .* may be left /);
		expect(existsSync(theirs), "the other tree's entry stays").toBe(true);
		expect(existsSync(join(other.at, ".git")), "and its .git file").toBe(true);
	});

	it("leaves another tree's entry its .git names, saying so, and puts the branch back once the tree is gone", async () => {
		const { gitDir, path, main, topic } = await checkout();
		const { at, cut: one } = await cut(gitDir, "planted");
		const other = await cut(gitDir, "other", "spare");
		const [own, theirs] = [
			await git(at, "rev-parse", "--absolute-git-dir"),
			await git(other.at, "rev-parse", "--absolute-git-dir"),
		];
		writeFileSync(join(at, ".git"), `gitdir: ${theirs}\n`);
		await git(path, "update-ref", "refs/heads/topic", main);
		const refusing = failing("remove", { code: 128, stderr: "fatal: no\n" });

		const left = await uncut(refusing, one, at, "topic", main);

		expect(left).toMatch(
			/^git's entry for the tree cut at .* may be left .*, where git worktree prune takes it out$/,
		);
		expect(existsSync(theirs), "the other tree's entry stays").toBe(true);
		expect(existsSync(own), "its own entry, unnamed, is said").toBe(true);
		expect(existsSync(at), "the tree itself is gone").toBe(false);
		expect(await standing(path, "topic"), "so its branch goes back").toBe(
			topic,
		);
	});
});

// Lenders and cloud machines run a git older than 2.43, which answers
// `show-ref --exists` with 129 and its whole usage; refusing there
// refused every carry onto them.
describe("cutting with a git too old to say a ref is missing", () => {
	const OLD = {
		code: 129,
		stderr:
			"error: unknown option `exists'\nusage: git show-ref [--head] [-d | --dereference]\n",
	};
	const old = failing("show-ref", OLD);

	it("cuts a branch that isn't there", async () => {
		const { gitDir } = await checkout();
		const at = join(folder(made, "trees"), "old-fresh");

		expect(await cutFrom(old, gitDir, at, "fresh")).toEqual({
			checkout: gitDir,
			before: undefined,
		});
	});

	it("cuts one that isn't there beside a broken ref of another", async () => {
		const { gitDir } = await checkout();
		writeFileSync(join(gitDir, "refs", "heads", "fresh-old"), "not a sha\n");
		const at = join(folder(made, "trees"), "old-beside-broken");

		expect(await cutFrom(old, gitDir, at, "fresh")).toEqual({
			checkout: gitDir,
			before: undefined,
		});
	});

	it("refuses where the branch's file is there though git didn't list it", async () => {
		const { gitDir } = await checkout();
		const unlisted: Exec = async (command, args) =>
			args.includes("for-each-ref")
				? { code: 0, stdout: "", stderr: "" }
				: old(command, args);
		const at = join(folder(made, "trees"), "old-unlisted");

		const refused = await cutFrom(unlisted, gitDir, at, "topic");

		expect("why" in refused ? refused.why : "").toMatch(
			/git has refs\/heads\/topic at .* but didn't list it$/,
		);
		expect(existsSync(at), "nothing was cut").toBe(false);
	});

	it("refuses where the listing warned of the branch's own ref", async () => {
		const { gitDir } = await checkout();
		writeFileSync(join(gitDir, "refs", "heads", "fresh"), "not a sha\n");
		const at = join(folder(made, "trees"), "old-broken");

		const refused = await cutFrom(old, gitDir, at, "fresh");

		// The listing's own word, not the file's, which ends the same way.
		expect("why" in refused ? refused.why : "").toMatch(
			/: warning: ignoring broken ref refs\/heads\/fresh$/,
		);
		expect(existsSync(at), "nothing was cut").toBe(false);
	});

	it.skipIf(process.getuid?.() === 0)(
		"refuses where the branches' folder can't be read, which the listing skips silently",
		async () => {
			const { gitDir } = await checkout();
			const heads = join(gitDir, "refs", "heads");
			const at = join(folder(made, "trees"), "old-unreadable");
			chmodSync(heads, 0o000);
			let refused: Awaited<ReturnType<typeof cutFrom>>;
			try {
				refused = await cutFrom(old, gitDir, at, "fresh");
			} finally {
				chmodSync(heads, 0o755);
			}

			expect("why" in refused ? refused.why : "").toMatch(
				/refs\/heads can't be read, so git can't say whether refs\/heads\/fresh is there$/,
			);
			expect(existsSync(at), "nothing was cut").toBe(false);
		},
	);

	/** The checkout with its branches' folder moved elsewhere and linked back. */
	async function linkedHeads() {
		const one = await checkout();
		const heads = join(one.gitDir, "refs", "heads");
		const elsewhere = join(folder(made, "elsewhere"), "heads");
		renameSync(heads, elsewhere);
		symlinkSync(elsewhere, heads);
		return { ...one, elsewhere };
	}

	it("cuts a branch that isn't there through a linked folder of branches", async () => {
		const { gitDir } = await linkedHeads();
		const at = join(folder(made, "trees"), "old-linked-fresh");

		expect(await cutFrom(old, gitDir, at, "fresh")).toEqual({
			checkout: gitDir,
			before: undefined,
		});
	});

	it.skipIf(process.getuid?.() === 0)(
		"refuses where a linked folder of branches can't be read, which a link alone hid",
		async () => {
			const { gitDir, elsewhere } = await linkedHeads();
			const at = join(folder(made, "trees"), "old-linked-unreadable");
			chmodSync(elsewhere, 0o000);
			let refused: Awaited<ReturnType<typeof cutFrom>>;
			try {
				refused = await cutFrom(old, gitDir, at, "fresh");
			} finally {
				chmodSync(elsewhere, 0o755);
			}

			expect("why" in refused ? refused.why : "").toMatch(
				/refs\/heads can't be read, so git can't say whether refs\/heads\/fresh is there$/,
			);
			expect(existsSync(at), "nothing was cut").toBe(false);
		},
	);

	// git prints the ref's path as it was given the git dir, `..` and all.
	it("refuses a branch's unlisted file through a git dir that isn't normalised", async () => {
		const { gitDir } = await checkout();
		writeFileSync(
			join(gitDir, "refs", "heads", "fresh"),
			"ref: refs/heads/nowhere\n",
		);
		const unlisted: Exec = async (command, args) =>
			args.includes("for-each-ref")
				? { code: 0, stdout: "", stderr: "" }
				: old(command, args);
		const at = join(folder(made, "trees"), "old-unnormalised");

		const refused = await cutFrom(unlisted, `${gitDir}/../.git`, at, "fresh");

		expect("why" in refused ? refused.why : "").toMatch(
			/git has refs\/heads\/fresh at .*\/\.git\/refs\/heads\/fresh but didn't list it$/,
		);
		expect(existsSync(at), "nothing was cut").toBe(false);
	});

	it("looks for a branch's file through a relative git dir", async () => {
		const { gitDir } = await checkout();
		const unlisted: Exec = async (command, args) =>
			args.includes("for-each-ref")
				? { code: 0, stdout: "", stderr: "" }
				: old(command, args);
		const at = join(folder(made, "trees"), "old-relative");

		const refused = await cutFrom(
			unlisted,
			relative(process.cwd(), gitDir),
			at,
			"topic",
		);

		expect("why" in refused ? refused.why : "").toMatch(
			/git has refs\/heads\/topic at .* but didn't list it$/,
		);
	});

	it("reads every folder of a branch named in parts", async () => {
		const { path, gitDir } = await checkout();
		await git(path, "branch", "team/topic", "topic");
		const unlisted: Exec = async (command, args) =>
			args.includes("for-each-ref")
				? { code: 0, stdout: "", stderr: "" }
				: old(command, args);

		expect(
			await cutFrom(
				old,
				gitDir,
				join(folder(made, "trees"), "old-parts"),
				"team/fresh",
			),
			"one that isn't there is cut",
		).toEqual({ checkout: gitDir, before: undefined });
		const refused = await cutFrom(
			unlisted,
			gitDir,
			join(folder(made, "trees"), "old-parts-unlisted"),
			"team/topic",
		);
		expect("why" in refused ? refused.why : "").toMatch(
			/git has refs\/heads\/team\/topic at .* but didn't list it$/,
		);
	});

	it("refuses where a folder of branches stands at the branch's own path", async () => {
		const { path, gitDir } = await checkout();
		await git(path, "branch", "team/topic", "topic");
		const at = join(folder(made, "trees"), "old-folder");

		const refused = await cutFrom(old, gitDir, at, "team");

		expect("why" in refused ? refused.why : "").toMatch(
			/a folder of refs stands at .*refs\/heads\/team, so git can't make refs\/heads\/team there$/,
		);
		expect(existsSync(at), "nothing was cut").toBe(false);
	});

	// 129 is also SIGHUP's 128 and 1, as exec reports a killed command.
	it("refuses where git was hung up on, rather than taking it for an old one", async () => {
		const { gitDir } = await checkout();
		const hungUp = failing("show-ref", {
			code: 129,
			stderr: "git was killed by SIGHUP",
		});
		const at = join(folder(made, "trees"), "old-hung-up");

		const refused = await cutFrom(hungUp, gitDir, at, "fresh");

		expect("why" in refused ? refused.why : "").toMatch(
			/^git couldn't read fresh in .*: git was killed by SIGHUP$/,
		);
		expect(existsSync(at), "nothing was cut").toBe(false);
	});
});
