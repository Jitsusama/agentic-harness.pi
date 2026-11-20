/**
 * The review and work tools run git and gh with nobody at the keyboard.
 *
 * They ran through pi's exec, whose child shares pi's terminal and is told
 * nothing about prompting. A git that wanted a password, or a gh that
 * wanted a login, drew its prompt over pi's interface and waited for keys
 * that never reached it, and the tool waited with it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	execUnattended,
	unattendedExec,
} from "../../../../lib/internal/sandbox/unattended-exec.ts";

/** Long enough that a command nothing stopped is plainly still running. */
const SLEEP_SECONDS = "30";
const STOPPED_WITHIN_MS = 2000;

describe("execUnattended", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("tells git and gh not to ask", async () => {
		const said = await execUnattended("sh", [
			"-c",
			'echo "$GIT_TERMINAL_PROMPT $GH_PROMPT_DISABLED"',
		]);

		expect(said.code).toBe(0);
		expect(said.stdout.trim()).toBe("0 1");
	});

	it("leads a process group of its own, away from pi's terminal", async () => {
		const said = await execUnattended("sh", [
			"-c",
			'echo "$$ $(ps -o pgid= -p $$)"',
		]);

		const [pid, group] = said.stdout.trim().split(/\s+/);
		expect(group).toBe(pid);
	});

	it("stops when its signal fires, and says it was killed", async () => {
		const stop = new AbortController();
		const running = execUnattended("sleep", [SLEEP_SECONDS], {
			signal: stop.signal,
		});
		setTimeout(() => stop.abort(), 50);

		const said = await Promise.race([
			running,
			new Promise<"still running">((resolve) =>
				setTimeout(() => resolve("still running"), STOPPED_WITHIN_MS),
			),
		]);

		expect(said).toMatchObject({ killed: true });
		expect(said).not.toMatchObject({ code: 0 });
	});

	it("runs where it is asked to", async () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "unattended-")));

		const said = await execUnattended("pwd", [], { cwd: dir });

		expect(said.stdout.trim()).toBe(dir);
	});
});

describe("unattendedExec", () => {
	let repository: string | undefined;

	afterEach(() => {
		vi.unstubAllEnvs();
		if (repository) rmSync(repository, { recursive: true, force: true });
		repository = undefined;
	});

	/** A repository where the fence keeps nothing read-only. */
	function unguardedRepository(): string {
		const made = realpathSync(mkdtempSync(join(tmpdir(), "unguarded-")));
		execFileSync("git", ["init", "-q", made]);
		return made;
	}

	it("runs git in a repository the fence doesn't guard, for an unfenced session", async () => {
		vi.stubEnv("PI_SANDBOX", "off");
		repository = unguardedRepository();

		const said = await unattendedExec()("git", ["-C", repository, "status"]);

		expect(said.code, said.stderr).toBe(0);
	});

	it("refuses git there when asked to hold to the fence, whatever its own sandbox", async () => {
		vi.stubEnv("PI_SANDBOX", "off");
		repository = unguardedRepository();

		// Not `rev-parse --git-dir`, which reads as naming the git folder
		// outright and so goes as asked.
		const said = await unattendedExec(undefined, true)("git", [
			"-C",
			repository,
			"status",
		]);

		expect(said.code, "a shell's code for a command it won't run").toBe(126);
		expect(said.stderr).toContain("the sandbox doesn't keep read-only");
	});
});
