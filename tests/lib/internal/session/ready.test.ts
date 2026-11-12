import { describe, expect, it } from "vitest";
import {
	readyLine,
	watchReady,
} from "../../../../lib/internal/session/ready.ts";

describe("readyLine", () => {
	it("says the whole milliseconds from start to ready, then the session", () => {
		expect(
			readyLine(1_000.25, 5_210.9, "01a1"),
			"health reads this wording",
		).toBe("pi: ready in 4211 ms, session 01a1");
	});

	it("never says a start took less than nothing", () => {
		expect(readyLine(2_000, 1_999, "s"), "a clock stepped back").toBe(
			"pi: ready in 0 ms, session s",
		);
	});
});

describe("watchReady", () => {
	it("times the process's own start, once", () => {
		const ready = watchReady();
		ready.started("startup");
		expect(ready.discovered(), "the first start is timed").toBe(true);
		expect(ready.discovered(), "and only once").toBe(false);
	});

	it("times no start inside a process already ready", () => {
		for (const reason of ["reload", "new", "resume", "fork"]) {
			const ready = watchReady();
			ready.started(reason);
			expect(ready.discovered(), `a ${reason} is not timed`).toBe(false);
		}
	});

	it("times nothing found before any session started", () => {
		expect(watchReady().discovered(), "no start, no line").toBe(false);
	});
});
