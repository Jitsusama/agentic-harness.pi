import { describe, expect, it } from "vitest";
import {
	readyLine,
	watchReady,
} from "../../../../lib/internal/session/ready.ts";

describe("readyLine", () => {
	it("says the whole milliseconds from start to ready, then the session", () => {
		expect(
			readyLine({ session: "01a1", readyMs: 4_210.75 }),
			"health reads this wording",
		).toBe("pi: ready in 4211 ms, session 01a1");
	});

	it("never says a start took less than nothing", () => {
		expect(
			readyLine({ session: "s", readyMs: -1 }),
			"a clock stepped back",
		).toBe("pi: ready in 0 ms, session s");
	});

	it("says the log's size and how far the start had got, after the session", () => {
		expect(
			readyLine({
				session: "01a1",
				readyMs: 4_210.75,
				logBytes: 38_204_112,
				loadedMs: 1_204.4,
				boundMs: 3_902.6,
			}),
			"the parts follow the wording health already reads",
		).toBe(
			"pi: ready in 4211 ms, session 01a1, log 38204112 bytes, loaded by 1204 ms, bound by 3903 ms",
		);
	});

	it("leaves out a part it couldn't see", () => {
		expect(
			readyLine({ session: "s", readyMs: 900, boundMs: 700 }),
			"no log file, as in an in-memory session",
		).toBe("pi: ready in 900 ms, session s, bound by 700 ms");
	});
});

describe("watchReady", () => {
	it("times the process's own start, once", () => {
		const ready = watchReady();
		ready.started("startup", 3_900);
		expect(ready.discovered(), "the first start is timed").toEqual({
			boundMs: 3_900,
		});
		expect(ready.discovered(), "and only once").toBeUndefined();
	});

	it("times no start inside a process already ready", () => {
		for (const reason of ["reload", "new", "resume", "fork"]) {
			const ready = watchReady();
			ready.started(reason, 100);
			expect(ready.discovered(), `a ${reason} is not timed`).toBeUndefined();
		}
	});

	it("times nothing found before any session started", () => {
		expect(watchReady().discovered(), "no start, no line").toBeUndefined();
	});
});
