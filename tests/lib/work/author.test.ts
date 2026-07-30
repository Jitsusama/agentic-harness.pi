import { describe, expect, it } from "vitest";
import { createGitAuthor, safeBranchName } from "../../../lib/work/index.js";
import { fakeExec } from "../review/support/fake-exec.js";

const ok = [{ when: [], stdout: "" }];

describe("safeBranchName", () => {
	it("accepts an ordinary branch name", () => {
		expect(safeBranchName("topic/fix-410")).toBe("topic/fix-410");
	});

	it("trims surrounding space rather than refusing over it", () => {
		expect(safeBranchName("  topic  ")).toBe("topic");
	});

	// git itself rejects some of these, but not all, and the ones it
	// accepts are worse: a name beginning with a dash is read as a
	// flag by every command that later takes it.
	it.each([
		["", "empty"],
		["   ", "blank"],
		["-topic", "a leading dash reads as a flag"],
		["a b", "a space"],
		["a..b", "a double dot"],
		["a~b", "a tilde"],
		["a^b", "a caret"],
		["a:b", "a colon"],
		["a?b", "a question mark"],
		["a*b", "a glob"],
		["a[b", "a bracket"],
		["a\\b", "a backslash"],
		["a b; rm -rf /", "a shell reach"],
		["topic/", "a trailing slash"],
		["/topic", "a leading slash"],
		["topic.lock", "the reserved .lock suffix"],
		["a\u0000b", "a null byte"],
	])("refuses %j because of %s", (name) => {
		expect(safeBranchName(name)).toBeUndefined();
	});
});

describe("recording work", () => {
	it("stages the paths it was given, in the tree it was given", async () => {
		const { exec, calls } = fakeExec(ok);
		const author = createGitAuthor({ exec });

		await author.stage("/trees/one", ["a.ts", "b.ts"]);

		expect(calls[0]?.args).toEqual([
			"-C",
			"/trees/one",
			"add",
			"--",
			"a.ts",
			"b.ts",
		]);
	});

	// A bare `git add` with no paths stages nothing, which looks like
	// success and commits nothing. Everything has to be asked for.
	it("stages everything when asked for everything", async () => {
		const { exec, calls } = fakeExec(ok);
		const author = createGitAuthor({ exec });

		await author.stage("/trees/one");

		expect(calls[0]?.args).toEqual(["-C", "/trees/one", "add", "--all"]);
	});

	it("commits with the subject as the first message", async () => {
		const { exec, calls } = fakeExec(ok);
		const author = createGitAuthor({ exec });

		await author.commit("/trees/one", { subject: "fix(a): do the thing" });

		expect(calls[0]?.args).toEqual([
			"-C",
			"/trees/one",
			"commit",
			"-m",
			"fix(a): do the thing",
		]);
	});

	// Two -m flags rather than one string with a blank line in it,
	// because git is the thing that knows how a body is separated
	// from a subject and doing it by hand invites getting it wrong.
	it("passes a body as its own message rather than splicing it", async () => {
		const { exec, calls } = fakeExec(ok);
		const author = createGitAuthor({ exec });

		await author.commit("/trees/one", {
			subject: "fix(a): do the thing",
			body: "Because it was broken.",
		});

		expect(calls[0]?.args).toEqual([
			"-C",
			"/trees/one",
			"commit",
			"-m",
			"fix(a): do the thing",
			"-m",
			"Because it was broken.",
		]);
	});

	it("refuses a commit with a blank subject", async () => {
		const { exec, calls } = fakeExec(ok);
		const author = createGitAuthor({ exec });

		await expect(
			author.commit("/trees/one", { subject: "  " }),
		).rejects.toThrow(/subject/i);
		expect(calls).toEqual([]);
	});
});

describe("moving a tree onto a branch", () => {
	it("creates the branch and checks it out", async () => {
		const { exec, calls } = fakeExec(ok);
		const author = createGitAuthor({ exec });

		await author.branch("/trees/one", "topic/fix");

		expect(calls[0]?.args).toEqual([
			"-C",
			"/trees/one",
			"checkout",
			"-b",
			"topic/fix",
		]);
	});

	it("starts the branch where it was told to", async () => {
		const { exec, calls } = fakeExec(ok);
		const author = createGitAuthor({ exec });

		await author.branch("/trees/one", "topic/fix", { from: "origin/main" });

		expect(calls[0]?.args).toEqual([
			"-C",
			"/trees/one",
			"checkout",
			"-b",
			"topic/fix",
			"origin/main",
		]);
	});

	// The refusal has to happen before git is called, or an unsafe
	// name reaches a command line and the check was decoration.
	it("refuses an unsafe branch name without calling git", async () => {
		const { exec, calls } = fakeExec(ok);
		const author = createGitAuthor({ exec });

		await expect(author.branch("/trees/one", "-rf")).rejects.toThrow(
			/branch name/i,
		);
		expect(calls).toEqual([]);
	});

	it("refuses an unsafe start point without calling git", async () => {
		const { exec, calls } = fakeExec(ok);
		const author = createGitAuthor({ exec });

		await expect(
			author.branch("/trees/one", "topic", { from: "--upload-pack=evil" }),
		).rejects.toThrow(/start/i);
		expect(calls).toEqual([]);
	});
});
