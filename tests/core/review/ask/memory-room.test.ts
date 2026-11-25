/**
 * Whether the machine has memory to start a council: the kernel's
 * memory `full avg60` under 10, or no reading at all.
 */

import { describe, expect, it } from "vitest";
import { memoryShort } from "../../../../lib/core/review/ask/memory-room.ts";

/** A pressure file as Linux writes it, with `full avg60` at `avg60`. */
const pressure = (avg60: string) => async () =>
	[
		"some avg10=23.19 avg60=16.16 avg300=17.63 total=56294624829",
		`full avg10=8.79 avg60=${avg60} avg300=6.91 total=29952573033`,
		"",
	].join("\n");

describe("whether the machine has memory for a round", () => {
	it("has room while full avg60 is under 10, whatever some reads", async () => {
		expect(await memoryShort(pressure("9.99"))).toBeUndefined();
	});

	it("is short at 10 and past it, saying the reading", async () => {
		expect(await memoryShort(pressure("10.00"))).toBe(
			"memory full avg60 was 10, at or past 10",
		);
		expect(await memoryShort(pressure("14.2"))).toContain("14.2");
	});

	it("has room where no pressure is kept, as on a Mac", async () => {
		expect(
			await memoryShort(async () => {
				throw Object.assign(new Error("no such file"), { code: "ENOENT" });
			}),
		).toBeUndefined();
	});

	it("has room when the reading holds no full line", async () => {
		expect(
			await memoryShort(async () => "some avg10=1 avg60=50 avg300=1 total=1\n"),
		).toBeUndefined();
	});
});
