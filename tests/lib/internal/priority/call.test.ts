import { describe, expect, it } from "vitest";
import {
	CALL_READ_MS,
	callReader,
	probeCall,
} from "../../../../lib/internal/priority/call.ts";

describe("whether the person is on a call", () => {
	it("reads a call probe's exit: 0 on, 1 off, anything else unknown", async () => {
		const exits = (code: number) => probeCall("sh", ["-c", `exit ${code}`]);

		expect(await exits(0)).toBe(true);
		expect(await exits(1)).toBe(false);
		expect(await exits(69), "the sound server unread").toBeUndefined();
		expect(await exits(64), "asked wrongly").toBeUndefined();
		expect(
			await probeCall("a-call-probe-that-is-not-there", []),
			"no probe",
		).toBeUndefined();
		// The probe outlasts its 50 ms and is stopped, never answering.
		expect(await probeCall("sh", ["-c", "sleep 5"], 50)).toBeUndefined();
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
		expect(await read()).toBe(false);
		expect(asked).toBe(2);
	});

	it("reads a probe that refuses as not knowing", async () => {
		const read = callReader(() => Promise.reject(new Error("gone")));

		expect(await read()).toBeUndefined();
	});
});
