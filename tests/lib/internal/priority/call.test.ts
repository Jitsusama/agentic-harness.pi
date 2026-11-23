import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CALL_KEPT_MS,
	CALL_READ_MS,
	callReader,
	probeCall,
} from "../../../../lib/internal/priority/call.ts";

/** Lets a probe started in the background settle. */
function flush(): Promise<void> {
	return new Promise((done) => setImmediate(done));
}

describe("whether the person is on a call", () => {
	it("reads a call probe's exit: 0 on, 1 off, anything else unknown", async () => {
		const exits = (code: number) => probeCall("sh", ["-c", `exit ${code}`]);

		expect(await exits(0), "exit 0 says a call is on").toBe(true);
		expect(await exits(1), "exit 1 says none is").toBe(false);
		expect(await exits(69), "the sound server unread").toBeUndefined();
		expect(await exits(64), "asked wrongly").toBeUndefined();
		expect(
			await probeCall("a-call-probe-that-is-not-there", []),
			"no probe",
		).toBeUndefined();
		// The probe outlasts its 50 ms and is stopped, never answering.
		expect(
			await probeCall("sh", ["-c", "sleep 5"], 50),
			"a probe past its time",
		).toBeUndefined();
	});

	it("stops waiting at its time for a probe that won't stop when asked", async () => {
		const started = performance.now();
		// A probe that ignores SIGTERM and would say a call is on at 5 s.
		const answer = await probeCall(
			"sh",
			["-c", "trap '' TERM; sleep 5; exit 0"],
			200,
		);
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
		const answer = await probeCall(
			"sh",
			["-c", `sleep 30 & echo $! > ${pidFile}; trap '' TERM; wait`],
			300,
		);
		const started = Number(readFileSync(pidFile, "utf8").trim());
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				// ESRCH: no such process, so it was killed and reaped.
				return false;
			}
		};
		// The kill lands at once, but the kernel reaps the orphan a moment later.
		const deadline = performance.now() + 2_000;
		while (alive(started) && performance.now() < deadline) {
			// A short poll for the reaping, bounded by the deadline above.
			await new Promise((wake) => setTimeout(wake, 20));
		}

		expect(answer, "a probe past its time says nothing").toBeUndefined();
		expect(alive(started), "the sleep the probe started is gone").toBe(false);
	});

	it("ages its answer by a clock the wall clock's steps don't move", async () => {
		let asked = 0;
		const read = callReader(() => {
			asked += 1;
			return Promise.resolve(true);
		});
		const wall = Date.now;
		try {
			await read();
			// The wall clock steps an hour forward: the answer is no older.
			Date.now = () => wall() + 3_600_000;
			await read();
		} finally {
			Date.now = wall;
		}

		expect(asked, "a step of the wall clock doesn't age the answer").toBe(1);
	});

	it("asks again only once its last answer is old, sharing one probe meanwhile", async () => {
		let now = 0;
		let asked = 0;
		let answer: boolean | undefined = true;
		const read = callReader(
			() => {
				asked += 1;
				return Promise.resolve(answer);
			},
			() => now,
		);

		const [first, second] = await Promise.all([read(), read()]);
		expect([first, second, asked], "one probe for two reads").toEqual([
			true,
			true,
			1,
		]);
		answer = false;
		now = CALL_READ_MS - 1;
		expect(await read(), "the last answer still stands").toBe(true);
		expect(asked, "no probe while it stands").toBe(1);
		now = CALL_READ_MS;
		await read();
		await flush();
		expect(await read(), "the probe's new answer, once the last is old").toBe(
			false,
		);
		expect(asked, "one probe once the last answer aged").toBe(2);
	});

	it("answers at once from its last answer while a fresh probe runs", async () => {
		let now = 0;
		let settle: (onCall: boolean) => void = () => undefined;
		const read = callReader(
			() =>
				now === 0
					? Promise.resolve(true)
					: new Promise<boolean>((done) => {
							settle = done;
						}),
			() => now,
		);
		await read();
		now = CALL_READ_MS;

		// The probe hangs; the read answers without waiting on it.
		expect(await read(), "the last answer, not the hanging probe").toBe(true);
		settle(false);
		await flush();
		expect(await read(), "the probe's answer once it came").toBe(false);
	});

	it("keeps a call through a probe that can't say, for a while", async () => {
		let now = 0;
		let answer: boolean | undefined = true;
		const read = callReader(
			() => Promise.resolve(answer),
			() => now,
		);
		await read();
		answer = undefined;

		now = CALL_READ_MS;
		await read();
		await flush();
		expect(await read(), "a call that just was is still on").toBe(true);
		now = CALL_KEPT_MS + CALL_READ_MS;
		await read();
		await flush();
		expect(await read(), "a call long unconfirmed is not known").toBe(
			undefined,
		);
	});

	it("asks a probe that can't say no more often than one that can", async () => {
		let now = 0;
		let asked = 0;
		const read = callReader(
			() => {
				asked += 1;
				return Promise.resolve(undefined);
			},
			() => now,
		);
		await read();
		now = CALL_READ_MS - 1;
		await read();
		await flush();

		expect(asked, "one probe within the read's time").toBe(1);
	});

	it("reads a probe that refuses as not knowing", async () => {
		const read = callReader(() => Promise.reject(new Error("gone")));

		expect(await read(), "a refusing probe").toBeUndefined();
	});
});
