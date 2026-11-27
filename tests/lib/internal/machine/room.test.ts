/**
 * Whether the machine has room to start a council: memory `full avg60`
 * under 5, at least 16 GiB of `MemAvailable` and CPU `some avg60` under
 * 40, with any reading the machine doesn't keep saying nothing, and CPU
 * alone the bar a round may pass in time.
 */

import { describe, expect, it } from "vitest";
import {
	cpuShort,
	type MachineReads,
	machineQuiet,
	machineShort,
} from "../../../../lib/internal/machine/room.ts";

const KIB_PER_GIB = 1024 * 1024;

/** A pressure file as Linux writes it, with `avg60` on the named line. */
const pressure =
	(line: "some" | "full", avg60: string) => async (): Promise<string> =>
		[
			`some avg10=23.19 avg60=${line === "some" ? avg60 : "1.00"} avg300=17.63 total=56294624829`,
			`full avg10=8.79 avg60=${line === "full" ? avg60 : "0.00"} avg300=6.91 total=29952573033`,
			"",
		].join("\n");

/** A meminfo file as Linux writes it, with `gib` GiB available of `total`. */
const meminfo =
	(gib: number, total = 125) =>
	async (): Promise<string> =>
		[
			`MemTotal:       ${Math.round(total * KIB_PER_GIB)} kB`,
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

/** Whether a machine quiet on every reading, with `over` put in, is quiet. */
const quiet = (over: Partial<MachineReads> = {}) =>
	machineQuiet({
		memoryPressure: pressure("full", "1.99"),
		cpuPressure: pressure("some", "24.99"),
		meminfo: meminfo(20),
		...over,
	});

/** What the machine says it is short of, or nothing when it has room. */
const saidOf = async (machine: MachineReads) =>
	(await machineShort(machine))?.said;

describe("whether the machine has room for a round", () => {
	it("has room while every reading is inside its bar", async () => {
		expect(await machineShort(reads())).toBeUndefined();
	});

	it("is short at memory full avg60 5 and past it, whatever some reads", async () => {
		expect(
			await saidOf(reads({ memoryPressure: pressure("full", "5.00") })),
		).toBe("memory full avg60 was 5, at or past 5");
		expect(
			await saidOf(reads({ memoryPressure: pressure("some", "90") })),
		).toBeUndefined();
	});

	it("is short under 16 GiB available, saying how much there was", async () => {
		expect(await saidOf(reads({ meminfo: meminfo(15.94) }))).toBe(
			"MemAvailable was 15.9 GiB, under 16.0",
		);
	});

	it("never says a reading just under the floor as the floor", async () => {
		expect(await saidOf(reads({ meminfo: meminfo(15.96) }))).toBe(
			"MemAvailable was 15.9 GiB, under 16.0",
		);
	});

	// 16 GiB free never comes on a 16 GiB laptop or an 8 GiB VM, so its
	// rounds would never start.
	it("wants half of a machine smaller than 32 GiB free", async () => {
		expect(await saidOf(reads({ meminfo: meminfo(8, 15.4) }))).toBeUndefined();
		expect(await saidOf(reads({ meminfo: meminfo(7.5, 15.4) }))).toBe(
			"MemAvailable was 7.5 GiB, under 7.7",
		);
	});

	// The council of 26 November: a floor rounded one way and a reading
	// the other could say 7.7 GiB was under 7.7.
	it("says a small machine's floor above any reading held under it", async () => {
		expect(await saidOf(reads({ meminfo: meminfo(7.69, 15.4) }))).toBe(
			"MemAvailable was 7.6 GiB, under 7.7",
		);
		expect(await saidOf(reads({ meminfo: meminfo(7.74, 15.5) }))).toBe(
			"MemAvailable was 7.7 GiB, under 7.8",
		);
	});

	// Its second council: a floor a couple of hundred kilobytes past 7.7 GiB,
	// and a reading under it but past 7.7, which rounding the floor to
	// the nearest tenth, or to a hundredth first, says as 7.7 under 7.7.
	it("says a floor just past a tenth as the tenth above", async () => {
		const kib = (total: number, available: number) => async () =>
			`MemTotal: ${total} kB\nMemAvailable: ${available} kB\n`;

		expect(await saidOf(reads({ meminfo: kib(16148480, 8074200) }))).toBe(
			"MemAvailable was 7.7 GiB, under 7.8",
		);
		// A floor two kilobytes past 7.7 GiB, and a reading one under it.
		expect(await saidOf(reads({ meminfo: kib(16148076, 8074037) }))).toBe(
			"MemAvailable was 7.7 GiB, under 7.8",
		);
	});

	it("is short at CPU some avg60 40 and past it, whatever full reads", async () => {
		expect(
			await saidOf(reads({ cpuPressure: pressure("some", "40.00") })),
		).toBe("CPU some avg60 was 40, at or past 40");
		expect(await saidOf(reads({ cpuPressure: pressure("some", "46.5") }))).toBe(
			"CPU some avg60 was 46.5, at or past 40",
		);
		expect(
			await saidOf(reads({ cpuPressure: pressure("full", "90") })),
		).toBeUndefined();
	});

	it("says every reading that is short, and names each", async () => {
		const short = await machineShort({
			memoryPressure: pressure("full", "12"),
			cpuPressure: pressure("some", "54"),
			meminfo: meminfo(8),
		});

		expect(short?.said).toBe(
			"memory full avg60 was 12, at or past 5; MemAvailable was 8.0 GiB, under 16.0; CPU some avg60 was 54, at or past 40",
		);
		expect(short?.readings).toEqual([
			"memory full avg60",
			"MemAvailable",
			"CPU some avg60",
		]);
	});

	// A210E4CA, 26 November: optimus sat past the CPU bar for hours.
	it("calls a hold passable only when CPU alone is short", async () => {
		const cpu = pressure("some", "46");
		const passable = async (over: Partial<MachineReads>) =>
			(await machineShort(reads(over)))?.passable;

		expect(
			await passable({ cpuPressure: cpu }),
			"CPU alone short, not passable",
		).toBe(true);
		expect(
			await passable({
				cpuPressure: cpu,
				memoryPressure: pressure("full", "6"),
			}),
			"memory pressure short too, passable",
		).toBe(false);
		expect(
			await passable({ cpuPressure: cpu, meminfo: meminfo(4) }),
			"available memory short too, passable",
		).toBe(false);
		expect(
			await passable({ meminfo: meminfo(4) }),
			"available memory alone short, passable",
		).toBe(false);
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

	it("reads a roll's room from the CPU alone, short at the bar and past it", async () => {
		expect(await cpuShort(pressure("some", "40"))).toBe(
			"CPU some avg60 was 40, at or past 40",
		);
		expect(await cpuShort(pressure("some", "39.99"))).toBeUndefined();
		expect(
			await cpuShort(pressure("full", "90")),
			"the full line is memory's bar, not the CPU's",
		).toBeUndefined();
		expect(await cpuShort(missing), "as on a Mac").toBeUndefined();
	});

	it("judges by the readings it has when one is missing", async () => {
		expect(
			await saidOf(
				reads({ meminfo: missing, cpuPressure: pressure("some", "41") }),
			),
		).toBe("CPU some avg60 was 41, at or past 40");
	});

	it("is quiet only under CPU some avg60 25, memory full avg60 2 and with 20 GiB available", async () => {
		expect(await quiet(), "every reading inside its bar").toBe(true);
		expect(
			await quiet({ memoryPressure: pressure("full", "2.00") }),
			"memory full avg60 at 2",
		).toBe(false);
		expect(
			await quiet({ cpuPressure: pressure("some", "25.00") }),
			"CPU some avg60 at 25",
		).toBe(false);
		expect(
			await quiet({ meminfo: meminfo(19.99) }),
			"under 20 GiB available",
		).toBe(false);
	});

	it("is never quiet where a reading isn't kept, as on a Mac", async () => {
		for (const gone of ["memoryPressure", "cpuPressure", "meminfo"] as const) {
			expect(await quiet({ [gone]: missing }), gone).toBe(false);
		}
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
