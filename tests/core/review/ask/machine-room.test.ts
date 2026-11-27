/**
 * Whether the machine has room to start a council: memory `full avg60`
 * under 5, at least 16 GiB of `MemAvailable` and CPU `some avg60` under
 * 40, with any reading the machine doesn't keep saying nothing.
 */

import { describe, expect, it } from "vitest";
import {
	type MachineReads,
	machineShort,
} from "../../../../lib/core/review/ask/machine-room.ts";

const KIB_PER_GIB = 1024 * 1024;

/** A pressure file as Linux writes it, with `avg60` on the named line. */
const pressure =
	(line: "some" | "full", avg60: string) => async (): Promise<string> =>
		[
			`some avg10=23.19 avg60=${line === "some" ? avg60 : "1.00"} avg300=17.63 total=56294624829`,
			`full avg10=8.79 avg60=${line === "full" ? avg60 : "0.00"} avg300=6.91 total=29952573033`,
			"",
		].join("\n");

/** A meminfo file as Linux writes it, with `gib` GiB available. */
const meminfo = (gib: number) => async (): Promise<string> =>
	[
		"MemTotal:       131072000 kB",
		"MemFree:          1024000 kB",
		`MemAvailable:   ${Math.round(gib * KIB_PER_GIB)} kB`,
		"",
	].join("\n");

const missing = async (): Promise<string> => {
	throw Object.assign(new Error("no such file"), { code: "ENOENT" });
};

/** A machine with room on every reading, with `over` put in. */
const reads = (over: Partial<MachineReads> = {}): MachineReads => ({
	memoryPressure: pressure("full", "4.99"),
	cpuPressure: pressure("some", "39.99"),
	meminfo: meminfo(16),
	...over,
});

describe("whether the machine has room for a round", () => {
	it("has room while every reading is inside its bar", async () => {
		expect(await machineShort(reads())).toBeUndefined();
	});

	it("is short at memory full avg60 5 and past it, whatever some reads", async () => {
		expect(
			await machineShort(reads({ memoryPressure: pressure("full", "5.00") })),
		).toBe("memory full avg60 was 5, at or past 5");
		expect(
			await machineShort(reads({ memoryPressure: pressure("some", "90") })),
		).toBeUndefined();
	});

	it("is short under 16 GiB available, saying how much there was", async () => {
		expect(await machineShort(reads({ meminfo: meminfo(15.9) }))).toBe(
			"MemAvailable was 15.9 GiB, under 16",
		);
	});

	it("is short at CPU some avg60 40 and past it, whatever full reads", async () => {
		expect(
			await machineShort(reads({ cpuPressure: pressure("some", "46.5") })),
		).toBe("CPU some avg60 was 46.5, at or past 40");
		expect(
			await machineShort(reads({ cpuPressure: pressure("full", "90") })),
		).toBeUndefined();
	});

	it("says every reading that is short", async () => {
		expect(
			await machineShort({
				memoryPressure: pressure("full", "12"),
				cpuPressure: pressure("some", "54"),
				meminfo: meminfo(8),
			}),
		).toBe(
			"memory full avg60 was 12, at or past 5; MemAvailable was 8.0 GiB, under 16; CPU some avg60 was 54, at or past 40",
		);
	});

	it("has room where no reading is kept, as on a Mac", async () => {
		expect(
			await machineShort({
				memoryPressure: missing,
				cpuPressure: missing,
				meminfo: missing,
			}),
		).toBeUndefined();
	});

	it("judges by the readings it has when one is missing", async () => {
		expect(
			await machineShort(
				reads({ meminfo: missing, cpuPressure: pressure("some", "41") }),
			),
		).toBe("CPU some avg60 was 41, at or past 40");
	});

	it("says nothing of a reading that holds no line it reads", async () => {
		expect(
			await machineShort(
				reads({
					memoryPressure: async () =>
						"some avg10=1 avg60=50 avg300=1 total=1\n",
					meminfo: async () => "MemTotal: 1 kB\n",
				}),
			),
		).toBeUndefined();
	});
});
