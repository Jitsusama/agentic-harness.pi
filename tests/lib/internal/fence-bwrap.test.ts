/**
 * The fence's binds over a real disk, through a real bubblewrap: what a
 * fenced command can and can't write in the repositories pi runs git in
 * outside the fence: a `git init` from a fenced command, followed by
 * pi's own git there, runs nothing. It skips only where no bubblewrap
 * can make a namespace, as inside another sandbox.
 */

import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fenceArgs } from "../../../lib/internal/fence.ts";
import { gitRun } from "../../../lib/internal/tree-git.ts";
import { disposeRepo, freshRepo } from "../../support/git-fixture.ts";

/** A bubblewrap on `PATH` that can make a namespace here, or nothing. */
function workingBwrap(): string | undefined {
	const found = spawnSync("bash", ["-c", "command -v bwrap"], {
		encoding: "utf8",
	}).stdout.trim();
	if (!found) return undefined;
	const tried = spawnSync(found, [
		"--unshare-user",
		"--ro-bind",
		"/",
		"/",
		"true",
	]);
	return tried.status === 0 ? found : undefined;
}

const bwrap = workingBwrap();

describe.skipIf(bwrap === undefined)(
	"what a fenced command can write where pi runs git",
	() => {
		let home: string;
		let template: string;
		let checkout: string;

		/** Whether `script` succeeds as a fenced command in `home`. */
		function fenced(script: string): boolean {
			const args = fenceArgs({ home, runtimeDir: undefined });
			const ran = spawnSync(
				bwrap ?? "bwrap",
				["--unshare-user", ...args, "sh", "-c", script],
				{ encoding: "utf8" },
			);
			return ran.status === 0;
		}

		beforeAll(async () => {
			home = realpathSync(mkdtempSync(join(tmpdir(), "fence-bwrap-")));
			template = await freshRepo("fence-bwrap");
			checkout = join(home, "src", "r");
			mkdirSync(checkout, { recursive: true });
			cpSync(template, checkout, { recursive: true });
		});

		afterAll(() => {
			rmSync(home, { recursive: true, force: true });
			disposeRepo(template);
		});

		it("makes no repository in src, so pi's git there finds none", () => {
			const made = join(home, "src", "made");
			expect(fenced(`git init -q ${made}`), "git init ran").toBe(false);
			expect(existsSync(made), `${made} was made`).toBe(false);
			expect(
				gitRun(made, ["status"], {
					home,
					fenced: true,
					trees: join(home, "trees"),
				}),
			).toEqual({ args: ["-c", "core.fsmonitor=false", "status"] });
		});

		it("adds nothing to a checkout's git folder that sends git elsewhere", () => {
			const git = join(checkout, ".git");
			expect(fenced(`echo /tmp > ${git}/commondir`), "a commondir").toBe(false);
			expect(fenced(`mkdir ${git}/modules`), "a modules folder").toBe(false);
			expect(fenced(`echo x >> ${git}/config`), "its settings").toBe(false);
			expect(existsSync(join(git, "commondir")), "commondir is there").toBe(
				false,
			);
		});

		it("writes neither a checkout's files nor anything new in src", () => {
			expect(fenced(`touch ${checkout}/new-file`), "a checkout's file").toBe(
				false,
			);
			expect(fenced(`touch ${home}/src/new-file`), "a file in src").toBe(false);
		});

		it("still writes what a commit in a worktree writes", () => {
			const objects = join(checkout, ".git", "objects");
			expect(
				fenced(`touch ${objects}/probe && rm ${objects}/probe`),
				"an object",
			).toBe(true);
			expect(
				fenced(`touch ${checkout}/.git/refs/heads/probe.lock`),
				"a ref's lock",
			).toBe(true);
		});
	},
);
