/**
 * Asking whether a call is on, from stand-ins that exit as
 * `a-call-is-on` does: 0 while a call is on, 1 while none is, anything
 * else when it can't tell, and 64 for arguments it doesn't take.
 */
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askCall } from "../../../../lib/internal/calls/probe.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "call-probe-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A stand-in `a-call-is-on` of its own, running `body`. */
function standIn(body: string, mode = 0o755): string {
	const program = join(dir, `probe-${Math.random().toString(36).slice(2)}`);
	writeFileSync(program, `#!/bin/sh\n${body}\n`);
	chmodSync(program, mode);
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

	it("reports no trouble for a program that can't tell, or doesn't answer in time", async () => {
		const cannotAsk = vi.fn();

		await askCall({ program: standIn("exit 2"), timeoutMs: 5_000, cannotAsk });
		await askCall({ program: standIn("exit 69"), timeoutMs: 5_000, cannotAsk });
		await askCall({ program: standIn("sleep 5"), timeoutMs: 200, cannotAsk });

		expect(
			cannotAsk,
			"a call it can't read now is not a broken program",
		).not.toHaveBeenCalled();
	});

	it("says on each ask that the program isn't there", async () => {
		const program = join(dir, "gone");
		const cannotAsk = vi.fn();

		const answers = [
			await askCall({ program, timeoutMs: 5_000, cannotAsk }),
			await askCall({ program, timeoutMs: 5_000, cannotAsk }),
		];

		expect(answers, "a missing program can't say").toEqual([
			undefined,
			undefined,
		]);
		expect(
			cannotAsk.mock.calls.map(([trouble]) => trouble.kind),
			"each ask says it, for its caller to keep or drop",
		).toEqual(["missing", "missing"]);
		expect(cannotAsk.mock.calls[0]?.[0].why).toMatch(/isn't on the PATH/);
	});

	it("says which arguments the program refuses", async () => {
		const program = standIn('[ "$1" = --here ] && exit 64; exit 1');
		const cannotAsk = vi.fn();

		await askCall({ program, args: ["--here"], timeoutMs: 5_000, cannotAsk });
		const plain = await askCall({ program, timeoutMs: 5_000, cannotAsk });

		expect(cannotAsk, "only the refused ask says so").toHaveBeenCalledTimes(1);
		expect(cannotAsk.mock.calls[0]?.[0]).toEqual({
			kind: "refused",
			why: `${program} doesn't take --here`,
		});
		expect(plain, "asked plainly, it answers").toBe(false);
	});

	it("says a program refusing no arguments refuses to answer", async () => {
		const cannotAsk = vi.fn();

		await askCall({ program: standIn("exit 64"), timeoutMs: 5_000, cannotAsk });

		expect(cannotAsk.mock.calls[0]?.[0].why).toMatch(
			/refuses to answer with no arguments/,
		);
	});

	it("says a program that is there but can't run is broken", async () => {
		const cannotAsk = vi.fn();

		await askCall({
			program: standIn("exit 0", 0o644),
			timeoutMs: 5_000,
			cannotAsk,
		});
		await askCall({
			program: standIn("a-command-that-is-not-there"),
			timeoutMs: 5_000,
			cannotAsk,
		});

		const orphan = join(dir, "orphan");
		writeFileSync(orphan, "#!/an/interpreter/that/is/not/there\nexit 0\n");
		chmodSync(orphan, 0o755);
		await askCall({ program: orphan, timeoutMs: 5_000, cannotAsk });

		expect(
			cannotAsk.mock.calls.map(([trouble]) => trouble.kind),
			"one not executable, one whose shell can't find a command, one whose interpreter is gone",
		).toEqual(["broken", "broken", "broken"]);
		expect(cannotAsk.mock.calls[2]?.[0].why).toBe(
			`${orphan} names an interpreter that isn't there`,
		);
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
		const pidFile = join(dir, "pid");
		// The probe starts a sleep of its own, then waits on it, ignoring TERM;
		// its time is long enough for a loaded machine to write the pid first.
		const answer = await askCall({
			program: standIn(
				`trap '' TERM; sleep 30 & echo $! > ${pidFile}.part; mv ${pidFile}.part ${pidFile}; wait`,
			),
			timeoutMs: 2_000,
		});
		expect(existsSync(pidFile), "the probe started its sleep").toBe(true);
		const started = Number(readFileSync(pidFile, "utf8").trim());
		expect(started, "the sleep's pid was written whole").toBeGreaterThan(0);
		// The kill lands at once, but the kernel reaps the orphan a moment later.
		const deadline = performance.now() + 2_000;
		while (alive(started) && performance.now() < deadline) {
			// A short poll for the reaping, bounded by the deadline above.
			await new Promise((wake) => setTimeout(wake, 20));
		}

		expect(answer, "a probe past its time says nothing").toBeUndefined();
		expect(alive(started), "the sleep the probe started is gone").toBe(false);
	}, 10_000);
});
