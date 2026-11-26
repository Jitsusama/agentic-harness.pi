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
import { disposeRepo, freshRepo, git } from "./git-fixture.ts";

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

	it("starts no maintenance from its own git, so nothing writes a repo it copies", async () => {
		await git(repo, "config", "--unset", "maintenance.auto");

		expect(await git(repo, "config", "--get", "maintenance.auto")).toBe(
			"false",
		);
	});

	it("hands out repos whose commits start no maintenance under anyone's git", async () => {
		// The code under test runs git with the process's settings, not the
		// fixture's, and git traces the maintenance a commit starts.
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
		);
		const { stderr } = await promisify(execFile)(
			"git",
			["commit", "-q", "--allow-empty", "-m", "from the code"],
			{
				cwd: repo,
				env: {
					...env,
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_TRACE: "1",
				},
			},
		);

		expect(stderr).toContain("built-in: git commit");
		expect(stderr).not.toContain("maintenance run");
	});

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
