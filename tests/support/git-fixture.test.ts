/**
 * The git fixture's own git ignores the settings of whoever runs the
 * suite, so a developer's global config can't hang or fail a test.
 */

import { execFile } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	disposeRepo,
	freshRepo,
	git,
	withoutGitSettings,
} from "./git-fixture.ts";

/** What git's trace says as a command starts background maintenance, of either kind. */
const STARTS_MAINTENANCE = /run_command: git (maintenance|gc)\b/;

describe("the git fixture", () => {
	let repo: string;
	let person: string;
	const was = {
		global: process.env.GIT_CONFIG_GLOBAL,
		editor: process.env.GIT_EDITOR,
		dir: process.env.GIT_DIR,
	};

	beforeEach(async () => {
		repo = await freshRepo("git-fixture");
		person = `${repo}-person`;
		mkdirSync(join(person, "hooks"), { recursive: true });
	});

	afterEach(() => {
		restore("GIT_CONFIG_GLOBAL", was.global);
		restore("GIT_EDITOR", was.editor);
		restore("GIT_DIR", was.dir);
		disposeRepo(repo);
		rmSync(person, { recursive: true, force: true });
	});

	it("reads none of the person's global settings", async () => {
		personSettings("[fixture]\n\tseen = yes\n");

		await expect(
			git(repo, "config", "--get", "fixture.seen"),
			"the person's setting reached the fixture's git",
		).rejects.toThrow();
	});

	it("commits past a hook the person's global config names", async () => {
		const hook = join(person, "hooks", "pre-commit");
		writeFileSync(hook, "#!/bin/sh\nexit 1\n");
		chmodSync(hook, 0o755);
		personSettings(`[core]\n\thooksPath = ${join(person, "hooks")}\n`);

		await git(repo, "commit", "-q", "--allow-empty", "-m", "past the hook");

		expect(await git(repo, "log", "-1", "--format=%s")).toBe("past the hook");
	});

	it("runs no editor the person names, so a missing message fails at once", async () => {
		const opened = join(person, "opened");
		const editor = join(person, "editor");
		writeFileSync(editor, `#!/bin/sh\ntouch '${opened}'\n`);
		chmodSync(editor, 0o755);
		process.env.GIT_EDITOR = editor;

		await expect(
			git(repo, "commit", "-q", "--allow-empty"),
			"a commit with no message went through",
		).rejects.toThrow();
		expect(existsSync(opened), "the person's editor was opened").toBe(false);
	});

	it("works in its own repository when the suite runs from a hook's", async () => {
		// A hook runs with GIT_DIR naming the repository it fired in.
		const theirs = await freshRepo("git-fixture-theirs");
		try {
			process.env.GIT_DIR = join(theirs, ".git");

			expect(await git(repo, "rev-parse", "--absolute-git-dir")).toBe(
				join(repo, ".git"),
			);
		} finally {
			disposeRepo(theirs);
		}
	});

	it("turns maintenance off on its own git's command line", async () => {
		expect(
			await git(repo, "config", "--show-scope", "--get", "maintenance.auto"),
			"git before 2.31 reads no settings from GIT_CONFIG_COUNT",
		).toBe("command\tfalse");
	});

	it("hands out copies whose commits start no maintenance from git's own settings", async () => {
		expect(
			await tracedCommit(repo, "-c", "maintenance.auto=true"),
			"this git's trace never shows a commit starting maintenance",
		).toMatch(STARTS_MAINTENANCE);

		expect(await tracedCommit(repo)).not.toMatch(STARTS_MAINTENANCE);
	});

	it("makes clones that start no maintenance or monitor of their own", async () => {
		const clone = `${repo}-clone`;
		try {
			await git(repo, "clone", "-q", repo, clone);

			expect(await tracedCommit(clone)).not.toMatch(STARTS_MAINTENANCE);
			expect(
				await git(clone, "config", "--local", "--get", "core.fsmonitor"),
			).toBe("false");
		} finally {
			disposeRepo(clone);
		}
	});

	/**
	 * A commit in `dir` by git as the code under test runs it, with the
	 * process's settings rather than the fixture's, and none of the
	 * person's or the system's, answering what git traced as it ran.
	 */
	async function tracedCommit(
		dir: string,
		...settings: string[]
	): Promise<string> {
		const { stderr } = await promisify(execFile)(
			"git",
			[...settings, "commit", "-q", "--allow-empty", "-m", "from the code"],
			{
				cwd: dir,
				env: {
					...withoutGitSettings(process.env),
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_TRACE: "1",
					// A clone holds none of the template's identity.
					GIT_AUTHOR_NAME: "Test",
					GIT_AUTHOR_EMAIL: "test@example.com",
					GIT_COMMITTER_NAME: "Test",
					GIT_COMMITTER_EMAIL: "test@example.com",
				},
			},
		);
		expect(stderr, "git traced nothing of the commit").toContain(
			"built-in: git commit",
		);
		return stderr;
	}

	/** Point git's global settings at a file holding these. */
	function personSettings(text: string): void {
		const file = join(person, "gitconfig");
		writeFileSync(file, text);
		process.env.GIT_CONFIG_GLOBAL = file;
	}
});

/** Put an environment variable back as it was, unset included. */
function restore(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
