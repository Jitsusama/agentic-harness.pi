/**
 * Whether the machine has room to start a council: memory `full avg60`
 * under 5, at least 16 GiB of `MemAvailable`, CPU `some avg60` under
 * 40 and io `full avg60` under 2 in each of the person's slices (or the
 * machine's, where they can't be read), with any reading the machine
 * doesn't keep saying nothing; and whether a room has, from what it
 * printed.
 */

import { describe, expect, it } from "vitest";
import {
	type MachineReads,
	machineQuiet,
	machineShort,
	roomQuiet,
	roomShort,
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

/** Each slice's io pressure, `full avg60` as given, others at 0. */
const slices =
	(full: Readonly<Record<string, string>> = {}) =>
	async (slice: string): Promise<string> =>
		pressure("full", full[slice] ?? "0.00")();

/** A machine with room on every reading, with `over` put in. */
const reads = (over: Partial<MachineReads> = {}): MachineReads => ({
	memoryPressure: pressure("full", "4.99"),
	cpuPressure: pressure("some", "39.99"),
	ioPressure: pressure("full", "4.99"),
	sliceIoPressure: slices({ "agents.slice": "1.99" }),
	meminfo: meminfo(16),
	...over,
});

/** What the room readings command prints on a room, with parts put in. */
const printed = (
	over: Partial<
		Record<"cpu" | "memory" | "io" | "meminfo" | "root", string>
	> = {},
): string =>
	[
		"## cpu",
		over.cpu ??
			"some avg10=1 avg60=39.99 avg300=1 total=1\nfull avg10=0 avg60=0 avg300=0 total=0",
		"## memory",
		over.memory ??
			"some avg10=1 avg60=9 avg300=1 total=1\nfull avg10=0 avg60=4.99 avg300=0 total=0",
		"## io",
		over.io ??
			"some avg10=1 avg60=9 avg300=1 total=1\nfull avg10=0 avg60=1.99 avg300=0 total=0",
		"## meminfo",
		over.meminfo ??
			`MemTotal: ${64 * KIB_PER_GIB} kB\nMemAvailable: ${40 * KIB_PER_GIB} kB`,
		"## root",
		over.root ??
			`Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 104857600 50000000 ${8 * KIB_PER_GIB} 50% /`,
		"",
	].join("\n");

/** Whether a machine quiet on every reading, with `over` put in, is quiet. */
const quiet = (over: Partial<MachineReads> = {}) =>
	machineQuiet({
		memoryPressure: pressure("full", "1.99"),
		cpuPressure: pressure("some", "24.99"),
		ioPressure: pressure("full", "0.00"),
		sliceIoPressure: slices(),
		meminfo: meminfo(20),
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
		expect(await machineShort(reads({ meminfo: meminfo(15.94) }))).toBe(
			"MemAvailable was 15.9 GiB, under 16.0",
		);
	});

	it("never says a reading just under the floor as the floor", async () => {
		expect(await machineShort(reads({ meminfo: meminfo(15.96) }))).toBe(
			"MemAvailable was 15.9 GiB, under 16.0",
		);
	});

	// 16 GiB free never comes on a 16 GiB laptop or an 8 GiB VM, so its
	// rounds would never start.
	it("wants half of a machine smaller than 32 GiB free", async () => {
		expect(
			await machineShort(reads({ meminfo: meminfo(8, 15.4) })),
		).toBeUndefined();
		expect(await machineShort(reads({ meminfo: meminfo(7.5, 15.4) }))).toBe(
			"MemAvailable was 7.5 GiB, under 7.7",
		);
	});

	it("is short at CPU some avg60 40 and past it, whatever full reads", async () => {
		expect(
			await machineShort(reads({ cpuPressure: pressure("some", "40.00") })),
		).toBe("CPU some avg60 was 40, at or past 40");
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
				ioPressure: pressure("full", "6.6"),
				sliceIoPressure: slices({ "agents.slice": "2.2" }),
				meminfo: meminfo(8),
			}),
		).toBe(
			"memory full avg60 was 12, at or past 5; MemAvailable was 8.0 GiB, under 16.0; CPU some avg60 was 54, at or past 40; io full avg60 in agents.slice was 2.2, at or past 2; io full avg60 was 6.6, at or past 5",
		);
	});

	it("has room where no reading is kept, as on a Mac", async () => {
		expect(
			await machineShort({
				memoryPressure: missing,
				cpuPressure: missing,
				ioPressure: missing,
				sliceIoPressure: missing,
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

	// 03:19 on 27 November: the machine read 6.6 while the slices read
	// 2.2, 0.24 and 0, the rest a capped background reader stalling alone.
	it("judges io by the person's slices, with the machine allowed to 5", async () => {
		expect(
			await machineShort(reads({ ioPressure: pressure("full", "4.99") })),
		).toBeUndefined();
		expect(
			await machineShort(reads({ ioPressure: pressure("full", "5.00") })),
		).toBe("io full avg60 was 5, at or past 5");
		expect(
			await machineShort(
				reads({ sliceIoPressure: slices({ "app.slice": "2.00" }) }),
			),
		).toBe("io full avg60 in app.slice was 2, at or past 2");
	});

	it("judges io by the machine's alone, at 2, where a slice can't be read", async () => {
		const noSession = async (slice: string): Promise<string> =>
			slice === "session.slice" ? missing() : pressure("full", "0.00")();
		expect(
			await machineShort(
				reads({
					ioPressure: pressure("full", "2.00"),
					sliceIoPressure: noSession,
				}),
			),
		).toBe("io full avg60 was 2, at or past 2");
		expect(
			await machineShort(
				reads({
					ioPressure: pressure("full", "1.99"),
					sliceIoPressure: missing,
				}),
			),
		).toBeUndefined();
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

describe("whether a room has room for a round", () => {
	it("has room while every reading it printed is inside its bar", () => {
		expect(roomShort(printed())).toBeUndefined();
	});

	it("says each pressure past its bar and a / under 8 GiB free", () => {
		expect(
			roomShort(
				printed({
					cpu: "some avg10=1 avg60=40 avg300=1 total=1",
					memory: "full avg10=1 avg60=5 avg300=1 total=1",
					io: "full avg10=1 avg60=2 avg300=1 total=1",
					root: `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 104857600 50000000 ${8 * KIB_PER_GIB - 1} 99% /`,
				}),
			),
		).toBe(
			"memory full avg60 was 5, at or past 5; CPU some avg60 was 40, at or past 40; io full avg60 was 2, at or past 2; the room's / had 7.9 GiB free, under 8.0",
		);
	});

	// The room's bars name no MemAvailable floor: its memory pressure
	// says what a shortage costs there (A210E4CA, d8565ffd).
	it("holds no round for its MemAvailable", () => {
		expect(
			roomShort(printed({ meminfo: `MemAvailable: ${KIB_PER_GIB} kB` })),
		).toBeUndefined();
	});

	it("has room where it printed nothing under a heading, or nothing at all", () => {
		expect(
			roomShort(printed({ cpu: "", memory: "", io: "", root: "" })),
		).toBeUndefined();
		expect(roomShort("")).toBeUndefined();
	});

	it("is quiet on the same readings as here", () => {
		const quietCpu = "some avg10=1 avg60=24.99 avg300=1 total=1";
		const quietMemory = "full avg10=0 avg60=1.99 avg300=0 total=0";
		expect(
			roomQuiet(printed({ cpu: quietCpu, memory: quietMemory })),
			"every reading inside its bar",
		).toBe(true);
		expect(
			roomQuiet(printed({ memory: quietMemory })),
			"CPU some avg60 at 39.99",
		).toBe(false);
		expect(
			roomQuiet(printed({ cpu: quietCpu, meminfo: "" })),
			"no memory counts printed",
		).toBe(false);
	});
});
