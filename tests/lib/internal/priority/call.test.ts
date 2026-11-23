import { describe, expect, it } from "vitest";
import {
	CALL_READ_MS,
	callReader,
	probeCall,
} from "../../../../lib/internal/priority/call.ts";

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
		expect(tookMs, "answered near its time, not at the probe's end").toBeLessThan(
			2_000,
		);
	});

	it("ages its answer by a clock that never steps back", async () => {
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
		expect([first, second, asked]).toEqual([true, true, 1]);
		answer = false;
		now = CALL_READ_MS - 1;
		expect(await read(), "the last answer still stands").toBe(true);
		expect(asked).toBe(1);
		now = CALL_READ_MS;
		expect(await read(), "the probe's new answer, once the last is old").toBe(
			false,
		);
		expect(asked).toBe(2);
	});

	it("reads a probe that refuses as not knowing", async () => {
		const read = callReader(() => Promise.reject(new Error("gone")));

		expect(await read()).toBeUndefined();
	});
});
