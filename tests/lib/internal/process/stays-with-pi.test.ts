import { describe, expect, it } from "vitest";
import {
	stayingWithPi,
	withPi,
} from "../../../../lib/internal/process/stays-with-pi.ts";

describe("staying with pi", () => {
	it("holds only while its spawning runs", () => {
		const during = withPi(() => stayingWithPi());

		expect(during, "inside withPi").toBe(true);
		expect(stayingWithPi(), "after withPi").toBe(false);
	});

	it("holds through a nested call until the outer one ends", () => {
		const seen = withPi(() => [withPi(() => stayingWithPi()), stayingWithPi()]);

		expect(seen).toEqual([true, true]);
		expect(stayingWithPi(), "after both").toBe(false);
	});

	it("lets go when its spawning throws", () => {
		expect(() =>
			withPi(() => {
				throw new Error("no such program");
			}),
		).toThrow("no such program");

		expect(stayingWithPi(), "after the throw").toBe(false);
	});

	it("answers what its spawning returns", () => {
		expect(withPi(() => 42)).toBe(42);
	});
});
