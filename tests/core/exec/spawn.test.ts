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
	EXIT_SAID_TOO_MUCH,
	EXIT_TIMED_OUT,
	NONINTERACTIVE_ENV,
	spawnExec,
} from "../../../lib/core/exec/index.ts";
import { until } from "../../support/until.ts";

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

/**
 * How long a stopped process gets to be gone. Short of the test's own
 * timeout, so a process that outlives its stop fails naming it rather
 * than as a test that ran too long.
 */
const GONE_WITHIN_MS = 3_000;

/**
 * A gate's words for a wait, made up for these cases; World's own are
 * pinned beside the queue (`queued-exec.test.ts`).
 */
const TURN = {
	waits: "gate: this one waits its turn",
	goes: ["its turn came after", "this one goes on"],
	longestMs: 10_000,
} as const;

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

	it("reports a command killed from outside by its signal, never as a plain no", async () => {
		const killed = await spawnExec()("sh", ["-c", "kill -KILL $$"]);
		expect(killed.code).toBe(137);
		expect(killed.stderr).toContain("sh was killed by SIGKILL");
		const no = await spawnExec()("sh", ["-c", "exit 1"]);
		expect(no).toMatchObject({ code: 1, stderr: "" });
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
		await until(
			"the aborted command's child to be gone",
			() => !alive(grandchild),
			GONE_WITHIN_MS,
		);
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
		await until(
			"the timed-out command's child to be gone",
			() => !alive(grandchild),
			GONE_WITHIN_MS,
		);
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
		await until(
			"the shell that ignored the polite stop to be killed",
			() => !alive(shell),
			GONE_WITHIN_MS,
		);
	});

	it("is stopped with everything it started once its output passes the ceiling", async () => {
		// The clock is only a backstop: without the ceiling this child never
		// ends, and the case should fail on how it ended, not on its own timeout.
		const result = await spawnExec({ timeoutMs: 5_000, maxOutputChars: 1_000 })(
			"sh",
			["-c", "echo $$ >&2; yes"],
		);
		const shell = Number(result.stderr.split("\n")[0]);

		expect(
			result.code,
			"a child that floods its stdout is stopped for it",
		).toBe(EXIT_SAID_TOO_MUCH);
		expect(
			result.stdout.length,
			"no more than the ceiling is held",
		).toBeLessThanOrEqual(1_000);
		expect(result.stderr, "the stop says why").toContain(
			"its stdout passed 1000 characters",
		);
		await until(
			"the shell that flooded its stdout to be gone",
			() => !alive(shell),
			GONE_WITHIN_MS,
		);
	});

	it("is stopped once its stderr passes the ceiling too", async () => {
		const result = await spawnExec({ timeoutMs: 5_000, maxOutputChars: 1_000 })(
			"sh",
			["-c", "yes >&2"],
		);

		expect(
			result.code,
			"a child that floods its stderr is stopped for it",
		).toBe(EXIT_SAID_TOO_MUCH);
		expect(result.stderr, "the stop says why").toContain(
			"its stderr passed 1000 characters",
		);
	});

	it("holds its clock while it says it waits its turn", async () => {
		// The wait alone outlasts the clock twice over; only the time either
		// side of it counts. The wait is said on a line after another.
		const result = await spawnExec({ timeoutMs: 800, turn: TURN })("sh", [
			"-c",
			"printf 'gate: another push is running\\ngate: this one waits its turn.\\n' >&2; sleep 1.6; echo 'gate: its turn came after 1 s' >&2; echo sent",
		]);

		expect(result.code, "a wait for its turn is not run time").toBe(0);
		expect(result.stdout).toBe("sent\n");
	});

	it("hears a wait said across two pieces of its output", async () => {
		const result = await spawnExec({ timeoutMs: 800, turn: TURN })("sh", [
			"-c",
			"printf 'gate: this one wai' >&2; sleep 0.2; printf 'ts its turn.\\n' >&2; sleep 1.6; echo 'gate: its turn came after 1 s' >&2; echo sent",
		]);

		expect(result.code, "a mark split between chunks is still a wait").toBe(0);
	});

	it("hears a wait and its end in one piece", async () => {
		const result = await spawnExec({
			timeoutMs: 800,
			signal: AbortSignal.timeout(4_000),
			turn: TURN,
		})("sh", [
			"-c",
			"printf 'gate: this one waits its turn\\nits turn came after 0 s\\n' >&2; sleep 1.6; echo sent",
		]);

		expect(result.code, "the wait ended in the piece it began").toBe(
			EXIT_TIMED_OUT,
		);
		expect(result.stderr).toContain("timed out after 800 ms");
	});

	it("hears a second wait said in the piece the first ends in", async () => {
		const result = await spawnExec({ timeoutMs: 800, turn: TURN })("sh", [
			"-c",
			"printf 'gate: this one waits its turn\\nits turn came after 0 s\\ngate: this one waits its turn\\n' >&2; sleep 1.6; echo 'its turn came after 1 s' >&2; echo sent",
		]);

		expect(result.code, "the second wait holds the clock too").toBe(0);
		expect(result.stdout).toBe("sent\n");
	});

	it("hears a wait only at a line's start", async () => {
		const result = await spawnExec({ timeoutMs: 800, turn: TURN })("sh", [
			"-c",
			"echo 'remote: gate: this one waits its turn' >&2; sleep 1.6; echo 'its turn came after 1 s' >&2; echo sent",
		]);

		expect(result.code, "a line passed on holds nothing").toBe(EXIT_TIMED_OUT);
		expect(result.stdout).not.toContain("sent");
	});

	it("carries only the time left before a wait across it", async () => {
		// 1.2 s before the wait and 1.2 s after it outrun a clock of 2 s
		// between them, though neither does alone; a wait of 1 s outruns
		// what is left of it, unless it holds.
		const result = await spawnExec({ timeoutMs: 2_000, turn: TURN })("sh", [
			"-c",
			"sleep 1.2; echo 'gate: this one waits its turn' >&2; sleep 1; echo 'its turn came after 1 s' >&2; echo back; sleep 1.2; echo sent",
		]);

		expect(result.stdout, "it ran on past the wait").toContain("back");
		expect(result.code, "the time after the wait is what was left").toBe(
			EXIT_TIMED_OUT,
		);
		expect(result.stdout).not.toContain("sent");
	});

	it("runs its clock again once its turn comes", async () => {
		const started = Date.now();
		const result = await spawnExec({
			timeoutMs: 400,
			signal: AbortSignal.timeout(3_000),
			turn: TURN,
		})("sh", [
			"-c",
			"echo 'gate: this one waits its turn.' >&2; sleep 0.8; echo 'gate: its turn came after 0 s' >&2; echo back; sleep 30",
		]);

		expect(result.stdout, "the wait outlasting the clock held it").toContain(
			"back",
		);
		expect(result.code, "what runs after the wait is on the clock").toBe(
			EXIT_TIMED_OUT,
		);
		expect(result.stderr).toContain("timed out after 400 ms");
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("is stopped when one wait for its turn runs past the longest", async () => {
		const started = Date.now();
		// A signal shorter than the test's own limit is the backstop, so a
		// wait nothing stops fails naming how it ended.
		const result = await spawnExec({
			timeoutMs: 2_000,
			signal: AbortSignal.timeout(3_000),
			turn: { ...TURN, longestMs: 300 },
		})("sh", ["-c", "echo 'gate: this one waits its turn.' >&2; sleep 30"]);

		expect(result.code, "a wait has a clock of its own").toBe(EXIT_TIMED_OUT);
		expect(result.stderr).toContain("waited its turn for over 300 ms");
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("counts its waits together against the longest", async () => {
		// Four waits of 400 ms each fit the longest alone, with room to
		// spare on a loaded machine, but not together.
		const result = await spawnExec({
			timeoutMs: 2_000,
			signal: AbortSignal.timeout(4_000),
			turn: { ...TURN, longestMs: 1_000 },
		})("sh", [
			"-c",
			"for i in 1 2 3 4; do echo 'gate: this one waits its turn' >&2; sleep 0.4; echo 'its turn came after 0 s' >&2; done; echo sent",
		]);

		expect(result.code, "saying it waits again earns no more").toBe(
			EXIT_TIMED_OUT,
		);
		expect(result.stderr).toContain("waited its turn for over 1000 ms");
	});

	it("reads a turn with an empty mark as no turn", async () => {
		const result = await spawnExec({
			timeoutMs: 300,
			signal: AbortSignal.timeout(3_000),
			// An empty wait's mark would hold at the first line, and nothing
			// would end it but the signal.
			turn: { waits: "", goes: ["its turn came after"], longestMs: 10_000 },
		})("sh", ["-c", "echo said >&2; sleep 30"]);

		expect(result.code, "an empty mark holds nothing").toBe(EXIT_TIMED_OUT);
		expect(result.stderr).toContain("timed out after 300 ms");
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
		expect((await spawnExec({ cwd: dir })("ls", [])).stdout).not.toContain(
			"ran",
		);
	});
});
