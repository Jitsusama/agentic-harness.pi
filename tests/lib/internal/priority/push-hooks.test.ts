import { execFileSync, spawnSync } from "node:child_process";
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
import { withoutOurs } from "../../../../lib/internal/priority/push-hooks.mjs";
import {
	placePushHooks,
	pushesLine,
	pushHook,
} from "../../../../lib/internal/priority/pushes.ts";

// A git of its own: no person's config, so nothing signs or hooks.
const GIT_ENV: NodeJS.ProcessEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
};
// The test's own shell may be a pushing walk's, already holding one.
delete GIT_ENV.GIT_CONFIG_COUNT;

// World's pre-push, as it runs each hook in pre-push.d in order.
const DISPATCHER = `#!/usr/bin/env bash
set -euo pipefail
export GIT_COMMON_DIR="\${GIT_COMMON_DIR-$(git rev-parse --path-format=absolute --git-common-dir)}"
INPUT=$(cat)
for hook in $(find -L "$GIT_COMMON_DIR/hooks/pre-push.d" -maxdepth 1 -mindepth 1 -type f -perm -u=x | sort); do
  "$hook" "$@" <<< "$INPUT"
done
`;

let root: string;
let queue: string;
let work: string;
let mark: string;

const git = (...args: string[]) =>
	execFileSync("git", ["-C", work, ...args], {
		encoding: "utf8",
		// What the hooks run in setting up is marked apart from the push's.
		env: { ...GIT_ENV, MARK: join(root, "setup") },
		input: "",
	}).trim();

const hookFile = (path: string, body: string) => {
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
};

const commit = (path: string, text: string) => {
	writeFileSync(join(work, path), text);
	git("add", path);
	git("commit", "-q", "-m", path);
};

/** Runs `script` in a shell set up as a pushing walk's is. */
const pushing = (script: string, env: Record<string, string> = {}) => {
	const line = pushesLine(queue);
	if (line === undefined) throw new Error("the queue's folder can't be quoted");
	return spawnSync("bash", ["-c", `${line}\n${script}`], {
		cwd: work,
		encoding: "utf8",
		env: { ...GIT_ENV, MARK: mark, ...env },
		timeout: 60_000,
	});
};

const ran = () => {
	try {
		return readFileSync(mark, "utf8").trim().split("\n");
	} catch {
		return [];
	}
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "push-hooks-"));
	queue = join(root, "jobs");
	work = join(root, "work");
	mark = join(root, "ran");
	const remote = join(root, "remote.git");
	execFileSync("git", ["init", "-q", "--bare", remote], { env: GIT_ENV });
	execFileSync("git", ["init", "-q", "-b", "main", work], { env: GIT_ENV });
	git("remote", "add", "origin", remote);
	commit(".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
	git("push", "-q", "origin", "main");
	const hooks = join(work, ".git", "hooks");
	mkdirSync(join(hooks, "pre-push.d"), { recursive: true });
	writeFileSync(join(hooks, "pre-push"), DISPATCHER);
	chmodSync(join(hooks, "pre-push"), 0o755);
	hookFile(
		join(hooks, "pre-push.d", "001-lfs"),
		'cat > /dev/null; echo lfs >> "$MARK"; exit 0 # git lfs pre-push "$@"',
	);
	hookFile(
		join(hooks, "pre-push.d", "011-other"),
		'read -r ref rest; echo "other $(git config --get core.hooksPath || echo unset) $ref" >> "$MARK"',
	);
	hookFile(join(hooks, "post-commit"), 'echo post-commit >> "$MARK"');
	expect(placePushHooks(queue)).toBe(true);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("a push of one existing branch", () => {
	it("leaves out the LFS hook when its commits hold no LFS file, and runs the rest", () => {
		commit("notes.txt", "plain\n");
		commit("more.txt", "plain too\n");
		const push = pushing("git push -q origin main");
		expect(push.status).toBe(0);
		expect(ran()).toEqual(["other unset refs/heads/main"]);
		expect(push.stderr).toContain(
			"left out the LFS scan, since its 2 changed paths",
		);
	});

	it("runs the LFS hook when a commit touches a path LFS filters", () => {
		commit("weights.bin", "binary\n");
		expect(pushing("git push -q origin main").status).toBe(0);
		expect(ran()).toEqual(["lfs", "other unset refs/heads/main"]);
	});

	it("runs the LFS hook when a commit adds a pointer where nothing filters", () => {
		commit(
			"pointer.txt",
			"version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n",
		);
		expect(pushing("git push -q origin main").status).toBe(0);
		expect(ran()).toEqual(["lfs", "other unset refs/heads/main"]);
	});

	it("runs the LFS hook when a commit changes what LFS filters", () => {
		commit(".gitattributes", "");
		expect(pushing("git push -q origin main").status).toBe(0);
		expect(ran()).toEqual(["lfs", "other unset refs/heads/main"]);
	});

	it("fails as the repository's own pre-push would when another hook refuses", () => {
		hookFile(
			join(work, ".git", "hooks", "pre-push.d", "012-refuses"),
			"exit 3",
		);
		commit("notes.txt", "plain\n");
		expect(pushing("git push -q origin main").status).not.toBe(0);
		expect(git("ls-remote", "origin", "main")).not.toContain(
			git("rev-parse", "HEAD"),
		);
	});
});

describe("a push of a new branch", () => {
	it("leaves out the LFS hook when what the remote lacks holds no LFS file", () => {
		commit("notes.txt", "plain\n");
		const push = pushing("git push -q origin main:topic");
		expect(push.status).toBe(0);
		expect(ran()).toEqual(["other unset refs/heads/main"]);
		expect(push.stderr).toContain("since its 1 changed paths");
	});

	it("runs the LFS hook when what the remote lacks touches a path LFS filters", () => {
		commit("weights.bin", "binary\n");
		expect(pushing("git push -q origin main:topic").status).toBe(0);
		expect(ran()).toEqual(["lfs", "other unset refs/heads/main"]);
	});
});

describe("a push of a branch rebased onto a newer main", () => {
	it("counts only its own commits, not main's it was rebased past", () => {
		git("checkout", "-q", "-b", "topic");
		commit("notes.txt", "plain\n");
		git("push", "-q", "origin", "topic");
		git("checkout", "-q", "main");
		commit("weights.bin", "binary\n");
		git("push", "-q", "origin", "main");
		git("checkout", "-q", "topic");
		git("rebase", "-q", "main");
		const push = pushing("git push -q --force-with-lease origin topic");
		expect(push.status).toBe(0);
		expect(ran()).toEqual(["other unset refs/heads/topic"]);
		expect(push.stderr).toContain("since its 1 changed paths");
	});
});

describe("any other push", () => {
	it("runs the repository's own pre-push whole for a deletion", () => {
		git("push", "-q", "origin", "main:topic");
		expect(pushing("git push -q origin :topic").status).toBe(0);
		expect(ran()).toEqual(["lfs", "other unset (delete)"]);
	});
});

describe("every other hook", () => {
	it("runs the repository's own, and the person's settings stay as they were", () => {
		const commitAndPush = pushing(
			'echo x > a.txt && git add a.txt && git commit -q -m a && echo "kept $(git config --get user.kept)" >> "$MARK" && git push -q origin main',
			{
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "user.kept",
				GIT_CONFIG_VALUE_0: "yes",
			},
		);
		expect(commitAndPush.status).toBe(0);
		expect(ran()).toEqual([
			"post-commit",
			"kept yes",
			"other unset refs/heads/main",
		]);
	});

	it("runs the repository's own as it is when the script is gone", () => {
		const wrapper = pushHook(
			"post-commit",
			process.execPath,
			join(root, "gone.mjs"),
		);
		if (wrapper === undefined) throw new Error("the paths can't be quoted");
		writeFileSync(join(queue, "pushes", "post-commit"), wrapper);
		const committing = pushing(
			"echo x > a.txt && git add a.txt && git commit -q -m a",
		);
		expect(committing.status).toBe(0);
		expect(ran()).toEqual(["post-commit"]);
	});
});

describe("withoutOurs", () => {
	it("takes off only the setting added last", () => {
		expect(
			withoutOurs({
				PI_PUSH_HOOKS_PRIOR: "1",
				GIT_CONFIG_COUNT: "2",
				GIT_CONFIG_KEY_0: "user.kept",
				GIT_CONFIG_VALUE_0: "yes",
				GIT_CONFIG_KEY_1: "core.hooksPath",
				GIT_CONFIG_VALUE_1: "/q/pushes",
			}),
		).toEqual({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "user.kept",
			GIT_CONFIG_VALUE_0: "yes",
		});
	});

	it("leaves no count when there was none", () => {
		expect(
			withoutOurs({
				PI_PUSH_HOOKS_PRIOR: "0",
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "core.hooksPath",
				GIT_CONFIG_VALUE_0: "/q/pushes",
			}),
		).toEqual({});
	});
});
