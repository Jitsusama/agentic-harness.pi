/**
 * What a room's readings say for the start line: what holds a round
 * whose reviewers run there, whether the room is quiet, how long one
 * answer stands for every round on this machine, and what a room that
 * doesn't answer leaves the round waiting on.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ROOM_READS_KEPT_MS,
	type RoomAt,
	roomReadings,
} from "../../../../extensions/review-integration/tools/room-readings.ts";

const room: RoomAt = {
	mycelium: "/run/node/bin/mycelium",
	realm: "work",
	machine: "room-1",
};

/** A pressure part whose avg60 is `avg60` on both lines. */
const pressure = (avg60: number) =>
	["some", "full"]
		.map((kind) => `${kind} avg10=0.00 avg60=${avg60} avg300=0.00 total=0`)
		.join("\n");

/** What the room prints, quiet on every part unless `cpu` says otherwise. */
const printed = (cpu = 0) =>
	[
		"## cpu",
		pressure(cpu),
		"## memory",
		pressure(0),
		"## io",
		pressure(0),
		"## meminfo",
		"MemTotal: 67108864 kB",
		"MemAvailable: 50331648 kB",
		"## root",
		"Filesystem 1024-blocks Used Available Capacity Mounted on",
		"/dev/root 41943040 10485760 31457280 25% /",
		"",
	].join("\n");

/** A room that answers each ask with the next of `answers`, counting asks. */
function answering(...answers: (string | undefined)[]) {
	const asked = { count: 0 };
	const ask = async () => {
		const answer = answers[Math.min(asked.count, answers.length - 1)];
		asked.count += 1;
		return answer;
	};
	return { asked, ask };
}

const folder = () => mkdtemp(join(tmpdir(), "room-reads-"));

describe("a room's readings for the start line", () => {
	it("hold a round while the room is short, said, and free it once it isn't", async () => {
		let now = 0;
		const { ask } = answering(printed(60), printed(0));
		const readings = roomReadings(room, {
			folder: await folder(),
			now: () => now,
			ask,
		});

		expect(await readings.short()).toMatch(/CPU some avg60 was 60/);
		now += ROOM_READS_KEPT_MS;
		expect(await readings.short()).toBeUndefined();
	});

	it("say the room is quiet only from what it printed", async () => {
		const { ask } = answering(printed(0));
		const readings = roomReadings(room, { folder: await folder(), ask });

		expect(await readings.quiet()).toBe(true);
	});

	it("ask the room once while its answer stands, for every round reading it", async () => {
		let now = 0;
		const kept = await folder();
		const { asked, ask } = answering(printed(0));
		const one = roomReadings(room, { folder: kept, now: () => now, ask });
		const another = roomReadings(room, { folder: kept, now: () => now, ask });

		await one.short();
		now += ROOM_READS_KEPT_MS - 1;
		await another.short();
		await another.quiet();
		expect(asked.count, "asked once in its first ten seconds").toBe(1);

		now += 1;
		await one.short();
		expect(asked.count, "asked again once it was ten seconds old").toBe(2);
	});

	it("keep a room that didn't answer as that, so a dead room isn't asked at every look", async () => {
		let now = 0;
		const { asked, ask } = answering(undefined);
		const readings = roomReadings(room, {
			folder: await folder(),
			now: () => now,
			ask,
			here: async () => undefined,
		});

		await readings.short();
		now += ROOM_READS_KEPT_MS - 1;
		await readings.short();
		expect(asked.count).toBe(1);
	});

	it("ask again for an answer stamped ahead of now, as from a clock set back", async () => {
		let now = ROOM_READS_KEPT_MS;
		const kept = await folder();
		const { asked, ask } = answering(printed(0));
		const readings = roomReadings(room, { folder: kept, now: () => now, ask });

		await readings.short();
		now = 0;
		await readings.short();
		expect(asked.count).toBe(2);
	});

	it("judge a round on this machine's bars when the room didn't answer, and never call it quiet", async () => {
		const { ask } = answering(undefined);
		const short = roomReadings(room, {
			folder: await folder(),
			ask,
			here: async () => "memory full avg60 was 9, at or past 5",
		});
		const free = roomReadings(room, {
			folder: await folder(),
			ask,
			here: async () => undefined,
		});

		expect(await short.short()).toBe(
			"the room room-1 didn't answer, so its round waits on this machine's bars: memory full avg60 was 9, at or past 5",
		);
		expect(await free.short()).toBeUndefined();
		expect(await free.quiet()).toBe(false);
	});
});
