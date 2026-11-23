import { describe, expect, it } from "vitest";
import {
	CALL_KEPT_MS,
	CALL_READ_MS,
	callReader,
	onCallIf,
} from "../../../../lib/internal/priority/call.ts";

/** Lets a probe started in the background settle. */
function flush(): Promise<void> {
	return new Promise((done) => setImmediate(done));
}

describe("whether the person is on a call", () => {
	it("marks a room reading only while a call is known to be on", async () => {
		const reading: { availableGib: number; vms: number; onCall?: boolean } = {
			availableGib: 12,
			vms: 0,
		};
		const saying = (onCall: boolean | undefined) => () =>
			Promise.resolve(onCall);

		expect(
			await onCallIf(saying(true), reading),
			"a call on marks the reading",
		).toEqual({ availableGib: 12, vms: 0, onCall: true });
		expect(
			await onCallIf(saying(false), reading),
			"no call leaves it as it was",
		).toBe(reading);
		expect(
			await onCallIf(saying(undefined), reading),
			"a call unknown leaves it as it was",
		).toBe(reading);
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
