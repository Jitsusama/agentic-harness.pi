/**
 * Git's state for pi's status line, from a machine's engine.
 *
 * The engine speaks gitstatusd's protocol and is kept running, so a
 * question costs a write rather than a process. These hold what an answer
 * says, what git is in the middle of, and that a burst of questions costs
 * two rather than one each, against a stand-in engine that writes down
 * what it was asked.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	Engine,
	type GitState,
	gitDir,
	operation,
	parseAnswer,
} from "../../../extensions/status-line-widget/git.ts";

/** An answer in gitstatusd's fields, from the index's size on. */
function answer(
	id: string,
	counts: {
		staged?: number;
		unstaged?: number;
		conflicted?: number;
		untracked?: number;
		ahead?: number;
		behind?: number;
	},
	branch = "main",
): string {
	return [
		id,
		"1",
		"/w/src",
		"0123456789abcdef",
		branch,
		"",
		"",
		"",
		"",
		"",
		String(counts.staged ?? 0),
		String(counts.unstaged ?? 0),
		String(counts.conflicted ?? 0),
		String(counts.untracked ?? 0),
		String(counts.ahead ?? 0),
		String(counts.behind ?? 0),
	].join("\x1f");
}

const none = () => null;

describe("an engine's answer", () => {
	it("reads a clean tree on a branch", () => {
		expect(parseAnswer(answer("7", {}), none)).toEqual({
			id: "7",
			state: {
				workdir: "/w/src",
				branch: "main",
				unstaged: false,
				staged: false,
				untracked: false,
				conflicted: false,
				ahead: 0,
				behind: 0,
				op: null,
			},
		});
	});

	it("tells unstaged, staged and untracked work apart", () => {
		const read = (counts: Parameters<typeof answer>[1]) =>
			parseAnswer(answer("1", counts), none).state;

		expect(read({ unstaged: 3 })).toMatchObject({
			unstaged: true,
			staged: false,
			untracked: false,
		});
		expect(read({ staged: 1 })).toMatchObject({
			unstaged: false,
			staged: true,
			untracked: false,
		});
		expect(read({ untracked: 2 })).toMatchObject({
			unstaged: false,
			staged: false,
			untracked: true,
		});
	});

	it("counts commits ahead and behind, and a conflict", () => {
		const { state } = parseAnswer(
			answer("1", { conflicted: 1, ahead: 2, behind: 3 }),
			none,
		);

		expect(state).toMatchObject({ conflicted: true, ahead: 2, behind: 3 });
	});

	it("reads an engine that didn't count as nothing there", () => {
		const { state } = parseAnswer(
			answer("1", { staged: -1, unstaged: -1, untracked: -1, ahead: -1 }),
			none,
		);

		expect(state).toMatchObject({
			unstaged: false,
			staged: false,
			untracked: false,
			ahead: 0,
		});
	});

	it("names a detached head by its commit's first seven characters", () => {
		const { state } = parseAnswer(answer("1", {}, ""), none);

		expect((state as GitState).branch).toBe("0123456");
	});

	it("says a folder outside a repository is in none", () => {
		expect(parseAnswer("4\x1f0", none)).toEqual({ id: "4", state: false });
	});
});

describe("what git is in the middle of", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "status-line-git-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("reads a rebase's step and its count", () => {
		mkdirSync(join(dir, "rebase-merge"));
		writeFileSync(join(dir, "rebase-merge/msgnum"), "2\n");
		writeFileSync(join(dir, "rebase-merge/end"), "5\n");

		expect(operation(dir)).toEqual({ name: "rebase", at: 2, of: 5 });
	});

	it("names a merge, with no steps", () => {
		writeFileSync(join(dir, "MERGE_HEAD"), "abc\n");

		expect(operation(dir)).toEqual({ name: "merge" });
	});

	it("says nothing while git is in the middle of nothing", () => {
		expect(operation(dir)).toBeNull();
	});

	it("finds a linked work tree's state where its .git file says", () => {
		const tree = join(dir, "tree");
		mkdirSync(tree);
		writeFileSync(join(tree, ".git"), `gitdir: ${join(dir, "real")}\n`);

		expect(gitDir(tree)).toBe(join(dir, "real"));
	});
});

describe("the engine, kept running", () => {
	let dir: string;
	let program: string;
	let asked: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "status-line-engine-"));
		asked = join(dir, "asked");
		program = join(dir, "engine");
		// Answers each folder as a clean main a moment after it's asked, so a
		// question asked meanwhile has to wait, and writes down each folder.
		const bash = execFileSync("sh", ["-c", "command -v bash"])
			.toString()
			.trim();
		writeFileSync(
			program,
			[
				`#!${bash}`,
				`: > ${JSON.stringify(asked)}`,
				"while IFS= read -r -d $'\\x1e' request; do",
				"  IFS=$'\\x1f' read -r id folder _ <<< \"$request\"",
				`  echo "$folder" >> ${JSON.stringify(asked)}`,
				"  sleep 0.2",
				'  printf \'%s\\x1f1\\x1f%s\\x1fabcdef0\\x1fmain\\x1f\\x1f\\x1f\\x1f\\x1f\\x1f0\\x1f1\\x1f0\\x1f0\\x1f1\\x1f0\\x1e\' "$id" "$folder"',
				"done",
			].join("\n"),
		);
		chmodSync(program, 0o755);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	/** What the engine answers, settled once it has answered `count` times. */
	function listen(count: number) {
		const got: [string, GitState | false][] = [];
		let settle = () => {};
		const all = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const answered = (folder: string, state: GitState | false) => {
			got.push([folder, state]);
			if (got.length === count) settle();
		};
		return { got, all, answered };
	}

	it("answers with the folder's state", async () => {
		const { got, all, answered } = listen(1);
		const engine = new Engine(program, answered, none);
		engine.ask(dir);
		await all;
		engine.stop();

		expect(got).toEqual([
			[
				dir,
				{
					workdir: dir,
					branch: "main",
					unstaged: true,
					staged: false,
					untracked: false,
					conflicted: false,
					ahead: 1,
					behind: 0,
					op: null,
				},
			],
		]);
	});

	it("holds questions asked while one is out and asks only the latest", async () => {
		const other = join(dir, "other");
		const latest = join(dir, "latest");
		mkdirSync(other);
		mkdirSync(latest);
		const { got, all, answered } = listen(2);
		const engine = new Engine(program, answered, none);
		engine.ask(dir);
		engine.ask(other);
		engine.ask(other);
		engine.ask(latest);
		await all;
		engine.stop();

		expect(got.map(([folder]) => folder)).toEqual([dir, latest]);
		expect(readFileSync(asked, "utf8").trim().split("\n")).toEqual([
			dir,
			latest,
		]);
	});

	it("goes quiet for a program that can't be started", async () => {
		const { got, answered } = listen(1);
		const engine = new Engine(join(dir, "missing"), answered, none);
		engine.ask(dir);
		// The failure to start arrives as an event, after the question.
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(() => engine.ask(dir)).not.toThrow();
		expect(got).toEqual([]);
	});

	it("doesn't start again a program that ended without answering", async () => {
		const starts = join(dir, "starts");
		const quitter = join(dir, "quitter");
		writeFileSync(
			quitter,
			`#!/bin/sh\necho start >> ${JSON.stringify(starts)}\n`,
		);
		chmodSync(quitter, 0o755);
		const engine = new Engine(quitter, () => {}, none);
		engine.ask(dir);
		await new Promise((resolve) => setTimeout(resolve, 300));
		engine.ask(dir);
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(readFileSync(starts, "utf8")).toBe("start\n");
	});
});
