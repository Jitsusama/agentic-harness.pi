/**
 * Asking whether a call is on, from stand-ins that exit as
 * `a-call-is-on` does: 0 while a call is on, 1 while none is, anything
 * else when it can't tell, and 64 for arguments it doesn't take.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { askCall } from "../../../../lib/internal/calls/probe.ts";

/** A stand-in `a-call-is-on` of its own, running `body`. */
function standIn(body: string): string {
	const program = join(mkdtempSync(join(tmpdir(), "call-probe-")), "probe");
	writeFileSync(program, `#!/bin/sh\n${body}\n`);
	chmodSync(program, 0o755);
	return program;
}

/** Whether `pid` still runs. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		// ESRCH: no such process, so it was killed and reaped.
		return false;
	}
}

describe("asking whether a call is on", () => {
	it("reads the exit: 0 on, 1 off, anything else unknown", async () => {
		const exits = (code: number) =>
			askCall({ program: standIn(`exit ${code}`), timeoutMs: 5_000 });

		expect(await exits(0), "exit 0 says a call is on").toBe(true);
		expect(await exits(1), "exit 1 says none is").toBe(false);
		expect(await exits(2), "it can't tell").toBeUndefined();
		expect(await exits(69), "the sound server unread").toBeUndefined();
		expect(await exits(64), "asked wrongly").toBeUndefined();
	});

	it("says once that the program isn't there, and answers unknown", async () => {
		const program = join(mkdtempSync(join(tmpdir(), "call-probe-")), "gone");
		const cannotAsk = vi.fn();

		const answers = [
			await askCall({ program, timeoutMs: 5_000, cannotAsk }),
			await askCall({ program, timeoutMs: 5_000, cannotAsk }),
		];

		expect(answers, "a missing program can't say").toEqual([
			undefined,
			undefined,
		]);
		expect(cannotAsk, "said once, not on every ask").toHaveBeenCalledTimes(1);
		expect(cannotAsk.mock.calls[0]?.[0]).toMatch(/not on the PATH/);
	});

	it("says once that the program doesn't take its arguments", async () => {
		const program = standIn('[ "$1" = --here ] && exit 64; exit 1');
		const cannotAsk = vi.fn();

		await askCall({ program, args: ["--here"], timeoutMs: 5_000, cannotAsk });
		await askCall({ program, args: ["--here"], timeoutMs: 5_000, cannotAsk });
		const plain = await askCall({ program, timeoutMs: 5_000, cannotAsk });

		expect(cannotAsk, "said once for --here").toHaveBeenCalledTimes(1);
		expect(cannotAsk.mock.calls[0]?.[0]).toMatch(/--here/);
		expect(plain, "asked plainly, it answers").toBe(false);
	});

	it("keeps its one saying for a caller that listens", async () => {
		const program = join(mkdtempSync(join(tmpdir(), "call-probe-")), "gone");
		const cannotAsk = vi.fn();

		await askCall({ program, timeoutMs: 5_000 });
		await askCall({ program, timeoutMs: 5_000, cannotAsk });

		expect(
			cannotAsk,
			"a caller with nowhere to say it doesn't use up the saying",
		).toHaveBeenCalledTimes(1);
	});

	it("stops waiting at its time for a probe that won't stop when asked", async () => {
		const started = performance.now();
		// A probe that ignores SIGTERM and would say a call is on at 5 s.
		const answer = await askCall({
			program: standIn("trap '' TERM; sleep 5; exit 0"),
			timeoutMs: 200,
		});
		const tookMs = performance.now() - started;

		expect(answer, "a probe past its time says nothing").toBeUndefined();
		expect(
			tookMs,
			"answered near its time, not at the probe's end",
		).toBeLessThan(2_000);
	});

	it("kills what a probe past its time started, not the probe alone", async () => {
		const pidFile = join(mkdtempSync(join(tmpdir(), "call-probe-")), "pid");
		// The probe starts a sleep of its own, then waits on it, ignoring TERM.
		const answer = await askCall({
			program: standIn(`sleep 30 & echo $! > ${pidFile}; trap '' TERM; wait`),
			timeoutMs: 300,
		});
		const started = Number(readFileSync(pidFile, "utf8").trim());
		// The kill lands at once, but the kernel reaps the orphan a moment later.
		const deadline = performance.now() + 2_000;
		while (alive(started) && performance.now() < deadline) {
			// A short poll for the reaping, bounded by the deadline above.
			await new Promise((wake) => setTimeout(wake, 20));
		}

		expect(answer, "a probe past its time says nothing").toBeUndefined();
		expect(alive(started), "the sleep the probe started is gone").toBe(false);
	});
});
