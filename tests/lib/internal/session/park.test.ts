/**
 * Parking a session: the switch, the marker and the wake.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	askWake,
	clearParked,
	isParked,
	NAMED_PARK_AFTER_MS,
	PARK_AFTER_MS,
	type Parked,
	parkAfterMs,
	parkSwitch,
	readParked,
	type Stillness,
	whyNotPark,
	writeParked,
} from "../../../../lib/internal/session/park.ts";

let folder: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "park-"));
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

const switchSays = (...lines: string[]) => {
	writeFileSync(parkSwitch(folder), `${lines.join("\n")}\n`);
	return parkSwitch(folder);
};

describe("whether a session parks, and after how long", () => {
	it("never parks with no switch and nothing in the environment", () => {
		expect(parkAfterMs("s-1", {}, parkSwitch(folder))).toBeUndefined();
	});

	it("parks every session after an hour once the switch or the environment says on", () => {
		expect(parkAfterMs("s-1", {}, switchSays("on"))).toBe(PARK_AFTER_MS);
		expect(parkAfterMs("s-1", { PI_PARK: "on" }, parkSwitch(folder))).toBe(
			PARK_AFTER_MS,
		);
	});

	it("parks the session the switch names soon, and no other", () => {
		const path = switchSays("s-1");
		expect(parkAfterMs("s-1", {}, path)).toBe(NAMED_PARK_AFTER_MS);
		expect(parkAfterMs("s-2", {}, path)).toBeUndefined();
	});

	it("never parks where the environment keeps it out", () => {
		const path = switchSays("on", "s-1");
		expect(parkAfterMs("s-1", { PI_PARK: "off" }, path)).toBeUndefined();
	});
});

describe("a parked session's marker and wake", () => {
	const marker = (wake: string): Parked => ({
		session: "s-1",
		sessionFile: "/logs/s-1.jsonl",
		cwd: "/src",
		addresses: ["85PKB2"],
		parkedAt: "2026-11-06T16:00:00.000Z",
		pid: 4242,
		wake,
	});

	it("says it is parked until it clears its marker on starting", () => {
		expect(isParked("s-1", folder)).toBe(false);
		writeParked(marker(join(folder, "s-1.wake")), folder);
		expect(isParked("s-1", folder)).toBe(true);
		expect(readParked("s-1", folder)?.sessionFile).toBe("/logs/s-1.jsonl");
		clearParked("s-1", folder);
		expect(isParked("s-1", folder)).toBe(false);
	});

	it("wakes it by writing to the file its holder watches", () => {
		const wake = join(folder, "s-1.wake");
		writeParked(marker(wake), folder);
		expect(askWake("s-1", "2-80ECO2-1-aaaa", folder)).toBe(true);
		expect(JSON.parse(readFileSync(wake, "utf8"))).toMatchObject({
			session: "s-1",
			messageId: "2-80ECO2-1-aaaa",
		});
	});

	it("wakes nothing for a session not parked", () => {
		expect(askWake("s-1", "2-80ECO2-1-aaaa", folder)).toBe(false);
	});
});

describe("why a session may not park now", () => {
	const still: Stillness = {
		idleMs: PARK_AFTER_MS,
		afterMs: PARK_AFTER_MS,
		agentIdle: true,
		pendingMessages: false,
		jobs: 0,
		prompting: false,
		typed: false,
		refusals: [],
	};

	it("lets a session idle past its time, with nothing out, park", () => {
		expect(whyNotPark(still)).toBeUndefined();
	});

	it("keeps it for each thing it still has out", () => {
		expect(whyNotPark({ ...still, afterMs: undefined })).toBe("parking is off");
		expect(whyNotPark({ ...still, idleMs: PARK_AFTER_MS - 1 })).toBe(
			"not idle long enough",
		);
		expect(whyNotPark({ ...still, agentIdle: false })).toBe(
			"a run is under way",
		);
		expect(whyNotPark({ ...still, pendingMessages: true })).toBe(
			"messages wait for it",
		);
		expect(whyNotPark({ ...still, jobs: 1 })).toBe("background jobs are out");
		expect(whyNotPark({ ...still, prompting: true })).toBe("a prompt is open");
		expect(whyNotPark({ ...still, typed: true })).toBe(
			"text is typed and unsent",
		);
		expect(
			whyNotPark({ ...still, refusals: ["peers wait on a hold it sent"] }),
		).toBe("peers wait on a hold it sent");
	});
});
