/**
 * The review and work tools run git and gh with nobody at the keyboard.
 *
 * They ran through pi's exec, whose child shares pi's terminal and is told
 * nothing about prompting. A git that wanted a password, or a gh that
 * wanted a login, drew its prompt over pi's interface and waited for keys
 * that never reached it, and the tool waited with it.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execUnattended } from "../../../lib/internal/unattended-exec.ts";

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
