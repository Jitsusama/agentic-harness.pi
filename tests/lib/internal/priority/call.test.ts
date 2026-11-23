import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	CALL_KEPT_MS,
	CALL_READ_MS,
	callReader,
	callWarning,
	onCallIf,
	probeCall,
} from "../../../../lib/internal/priority/call.ts";

/** A stand-in `a-call-is-on` running `body`, in a folder of its own. */
function standIn(body: string): { program: string; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "queue-call-"));
	const program = join(dir, "a-call-is-on");
	writeFileSync(program, `#!/bin/sh\n${body}\n`);
	chmodSync(program, 0o755);
	return { program, dir };
}

describe("the queue's call probe", () => {
	it("asks about this machine alone, with --here", async () => {
		const { program, dir } = standIn('[ "$1" = --here ] && exit 0; exit 1');
		try {
			expect(await probeCall(undefined, program), "asked with --here").toBe(
				true,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("passes why it can't ask on to its hearer", async () => {
		const { program, dir } = standIn("exit 64");
		const cannotAsk = vi.fn();
		try {
			await probeCall(cannotAsk, program);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}

		expect(cannotAsk.mock.calls[0]?.[0]).toEqual({
			kind: "refused",
			why: `${program} doesn't take --here`,
		});
	});
});

describe("a session's warning that calls can't be held for", () => {
	it("says the first reason once, however many it hears", () => {
		const warning = callWarning();

		expect(warning.take(), "nothing heard, nothing said").toBeUndefined();
		warning.heard({ kind: "refused", why: "a-call-is-on doesn't take --here" });
		warning.heard({ kind: "broken", why: "a-call-is-on can't be started" });

		expect(warning.take(), "the first reason, said").toBe(
			"a-call-is-on doesn't take --here, so heavy work starts even while you're on a call.",
		);
		warning.heard({ kind: "broken", why: "a-call-is-on can't be started" });
		expect(warning.take(), "said once a session").toBeUndefined();
	});

	it("says nothing on a machine with no a-call-is-on at all", () => {
		const warning = callWarning();
		warning.heard({ kind: "missing", why: "a-call-is-on isn't on the PATH" });

		expect(warning.take(), "nothing set up, nothing broken").toBeUndefined();
	});
});

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
