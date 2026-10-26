import { describe, expect, it } from "vitest";
import * as clock from "../../../lib/clock/index.ts";
import * as web from "../../../lib/core/web/bound.ts";

// The race itself is covered in tests/web/bound.test.ts, where it was
// first written. This is about where it can be reached from: the clock
// barrel is the public door, so a caller bounding a language server or
// an HTTP client does not have to import it out of the browser layer.
describe("bounded, from the clock barrel", () => {
	it("is offered with its errors", () => {
		expect(typeof clock.bounded).toBe("function");
		expect(typeof clock.abortError).toBe("function");
		expect(typeof clock.isAbort).toBe("function");
		expect(typeof clock.WallClockExceeded).toBe("function");
	});

	it("is the same one the browser layer uses", () => {
		expect(clock.bounded).toBe(web.bounded);
		expect(clock.WallClockExceeded).toBe(web.WallClockExceeded);
	});

	it("gives up on work the moment its signal fires", async () => {
		const controller = new AbortController();
		const never = new Promise<never>(() => {});
		const ending = clock.bounded(never, {
			signal: controller.signal,
			wallMs: 60_000,
			what: "waiting on nothing",
		});
		controller.abort();
		await expect(ending).rejects.toMatchObject({ name: "AbortError" });
	});
});
