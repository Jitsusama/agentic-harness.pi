/**
 * A command run with nobody at the keyboard.
 *
 * What matters is what the child cannot do: read a terminal it was never
 * given, wait on an input nobody will write, or outlive the request that
 * started it. Each case runs a real child, since the property is the
 * operating system's and a fake would only restate the implementation.
 */

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EXIT_ABORTED,
	EXIT_TIMED_OUT,
	NONINTERACTIVE_ENV,
	spawnExec,
} from "../../../lib/core/exec/index.ts";

/** Whether a pid still names a running process. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		// ESRCH: nothing by that pid, which is the answer.
		return false;
	}
}

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return check();
}

describe("a command run unattended", () => {
	it("returns what it said and how it exited", async () => {
		const result = await spawnExec()("sh", [
			"-c",
			"echo out; echo err >&2; exit 3",
		]);
		expect(result).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
	});

	it("reports a missing binary as a failure rather than throwing", async () => {
		const result = await spawnExec()("no-such-binary-anywhere", []);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("no-such-binary-anywhere");
	});

	it("runs where it is told to", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "spawn-")));
		const result = await spawnExec({ cwd: dir })("pwd", []);
		expect(result.stdout.trim()).toBe(dir);
	});

	it("leads its own session, so it has no terminal to prompt on", async () => {
		// A session leader is its own process group. A child in ours shares
		// our group, and with it the terminal git and ssh open for a prompt.
		const result = await spawnExec()("sh", [
			"-c",
			'echo "$$ $(ps -o pgid= -p $$)"',
		]);
		const [pid, group] = result.stdout.trim().split(/\s+/);
		expect(group).toBe(pid);
	});

	it("reads end of input at once instead of waiting on a keyboard", async () => {
		const started = Date.now();
		const result = await spawnExec({ timeoutMs: 5000 })("cat", []);
		expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("tells git and gh not to ask, and keeps the rest of the environment", async () => {
		const result = await spawnExec()("sh", [
			"-c",
			'echo "$GIT_TERMINAL_PROMPT $GH_PROMPT_DISABLED $HOME"',
		]);
		expect(result.stdout.trim()).toBe(`0 1 ${process.env.HOME}`);
		expect(NONINTERACTIVE_ENV.GIT_TERMINAL_PROMPT).toBe("0");
	});

	it("lets a caller's environment override the defaults", async () => {
		const result = await spawnExec({ env: { GIT_TERMINAL_PROMPT: "1" } })(
			"sh",
			["-c", 'echo "$GIT_TERMINAL_PROMPT"'],
		);
		expect(result.stdout.trim()).toBe("1");
	});
});

describe("a command that will not finish", () => {
	it("is stopped with everything it started when the signal fires", async () => {
		const stop = new AbortController();
		const running = spawnExec({ signal: stop.signal })("sh", [
			"-c",
			"sleep 30 & echo $!; wait",
		]);
		// Long enough for the shell to have started its own child.
		await new Promise((resolve) => setTimeout(resolve, 300));
		stop.abort();
		const result = await running;
		const grandchild = Number(result.stdout.trim());

		expect(result.code).toBe(EXIT_ABORTED);
		expect(result.stderr).toContain("aborted");
		expect(grandchild).toBeGreaterThan(0);
		expect(await until(() => !alive(grandchild))).toBe(true);
	});

	it("is stopped with everything it started when its clock runs out", async () => {
		const started = Date.now();
		const result = await spawnExec({ timeoutMs: 300 })("sh", [
			"-c",
			"sleep 30 & echo $!; wait",
		]);
		const grandchild = Number(result.stdout.trim());

		expect(result.code).toBe(EXIT_TIMED_OUT);
		expect(result.stderr).toContain("timed out after 300 ms");
		expect(Date.now() - started).toBeLessThan(3000);
		expect(await until(() => !alive(grandchild))).toBe(true);
	});

	it("is killed outright when it ignores the polite stop", async () => {
		const started = Date.now();
		const result = await spawnExec({ timeoutMs: 200, killGraceMs: 300 })("sh", [
			"-c",
			"trap '' TERM; echo $$; while :; do sleep 0.1; done",
		]);
		const shell = Number(result.stdout.trim());

		expect(result.code).toBe(EXIT_TIMED_OUT);
		expect(Date.now() - started).toBeLessThan(3000);
		expect(await until(() => !alive(shell))).toBe(true);
	});

	it("never starts when its signal has already fired", async () => {
		const stop = new AbortController();
		stop.abort();
		const dir = mkdtempSync(join(tmpdir(), "spawn-"));
		const result = await spawnExec({ signal: stop.signal, cwd: dir })("sh", [
			"-c",
			"touch ran",
		]);
		expect(result.code).toBe(EXIT_ABORTED);
		expect(
			(await spawnExec({ cwd: dir })("ls", [])).stdout.includes("ran"),
		).toBe(false);
	});
});
