/** A child host's wiring of its roll: its install, its hour, its room and its spread, and its stop. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	ROLL_ONLY_AFTER_MS,
	ROLL_SPREAD_MS,
	rollChildWhenStale,
} from "../../../host/service/stale-child.ts";
import { manualTimers } from "./support/manual-timers.ts";

// The CPU's pressure as a child reads it by default, set by a case.
const cpu = vi.hoisted(() => ({ short: undefined as string | undefined }));
vi.mock("../../../lib/internal/machine/room.ts", () => ({
	cpuShort: async () => cpu.short,
}));

describe("rollChildWhenStale", () => {
	/** A version under no install, which its own ask never finds moved. */
	const NO_INSTALL = "/nowhere/tree";

	it("asks its version's install, saying it couldn't tell while the install's link can't be read", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "h1-roll-")));
		try {
			const version = join(root, "install", "versions", "one");
			await mkdir(join(version, "scripts"), { recursive: true });
			await writeFile(join(version, "scripts", "pi-host.ts"), "export {};\n");
			const timers = manualTimers();
			const reported: unknown[] = [];
			rollChildWhenStale({
				version,
				host: () => undefined,
				stopped: new Promise(() => undefined),
				report: (message) => reported.push(message),
				lookMs: 1,
				after: timers.after,
				bornAt: 0,
				now: () => ROLL_ONLY_AFTER_MS,
				spreadMs: 0,
				roomShort: async () => undefined,
			});
			await timers.fire();
			// A real install's look reads the disk, so it takes more than a turn.
			await vi.waitFor(() => expect(timers.due).toHaveLength(1));
			expect(reported).toEqual([
				`Couldn't tell whether the install's host code moved on, so it looks again: the install's ${join(root, "install", "current")} can't be read`,
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	/** A child's wiring, its host stopping when `stop` is called. */
	function wired(
		moved: () => Promise<string | undefined>,
		clock: {
			bornAt?: number;
			now?: () => number;
			roomShort?: () => Promise<string | undefined>;
		} = {},
	) {
		const timers = manualTimers();
		const reported: unknown[] = [];
		const rolled: string[] = [];
		let host: { roll(): void } | undefined;
		let end = (_how: "resolve" | "reject"): void => undefined;
		const stopped = new Promise<void>((resolve, reject) => {
			end = (how) => (how === "resolve" ? resolve() : reject(new Error("x")));
		});
		// The rejection is the child's host failing, which its program handles.
		stopped.catch(() => undefined);
		rollChildWhenStale({
			version: NO_INSTALL,
			moved,
			host: () => host,
			stopped,
			report: (message) => reported.push(message),
			lookMs: 1,
			after: timers.after,
			// A child an hour old unless a case says otherwise.
			bornAt: clock.bornAt ?? 0,
			now: clock.now ?? (() => ROLL_ONLY_AFTER_MS),
			// No spread, and room, unless a case says otherwise.
			spreadMs: 0,
			roomShort: clock.roomShort ?? (async () => undefined),
		});
		return {
			timers,
			reported,
			rolled,
			holds: (name: string) => {
				host = { roll: () => rolled.push(name) };
			},
			end,
		};
	}

	it("rolls the host holding the conversation when the install moves, saying why", async () => {
		const child = wired(async () => "the host's code differs");
		child.holds("made after the wiring");
		await child.timers.fire();
		expect(child.rolled).toEqual(["made after the wiring"]);
		expect(child.reported).toEqual([
			"Rolling onto new code, as the host's code differs: the conversation parks at its next quiet moment unless a window views it",
		]);
	});

	it("rolls a child no sooner than an hour after it started, so a conversation rolls at most once an hour", async () => {
		expect(ROLL_ONLY_AFTER_MS, "an hour").toBe(60 * 60_000);
		let now = 10_000;
		const child = wired(async () => "the host's code differs", {
			bornAt: 10_000,
			now: () => now,
		});
		child.holds("young");
		now += 6 * 60_000;
		await child.timers.fire();
		expect(child.rolled, "six minutes old").toEqual([]);
		expect(child.timers.due.map(({ ms }) => ms)).toEqual([
			ROLL_ONLY_AFTER_MS - 6 * 60_000,
		]);

		now = 10_000 + ROLL_ONLY_AFTER_MS;
		await child.timers.fire();
		expect(child.rolled).toEqual(["young"]);
	});

	it("takes its start as the wiring's moment when it isn't told one", async () => {
		const timers = manualTimers();
		const rolled: string[] = [];
		// Long past an hour since the epoch, so a start taken as 0 would roll.
		const wiredAt = 10 * ROLL_ONLY_AFTER_MS;
		let now = wiredAt;
		rollChildWhenStale({
			version: NO_INSTALL,
			moved: async () => "moved",
			host: () => ({ roll: () => rolled.push("rolled") }),
			stopped: new Promise(() => undefined),
			report: () => undefined,
			lookMs: 1,
			after: timers.after,
			now: () => now,
			spreadMs: 0,
			roomShort: async () => undefined,
		});
		now += 1;
		await timers.fire();
		expect(rolled, "just started").toEqual([]);
		now = wiredAt + ROLL_ONLY_AFTER_MS;
		await timers.fire();
		expect(rolled).toEqual(["rolled"]);
	});

	it("times its hour on a clock that a wall clock put back doesn't move", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2030-06-01T00:00:00Z"));
			const timers = manualTimers();
			rollChildWhenStale({
				version: NO_INSTALL,
				moved: async () => "moved",
				host: () => undefined,
				stopped: new Promise(() => undefined),
				report: () => undefined,
				lookMs: 1,
				after: timers.after,
				spreadMs: 0,
				roomShort: async () => undefined,
			});
			vi.setSystemTime(new Date("2029-06-01T00:00:00Z"));
			await timers.fire();
			expect(
				timers.due.map(({ ms }) => ms <= ROLL_ONLY_AFTER_MS),
				"a year put back holds it no longer than its hour",
			).toEqual([true]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("holds its roll while the machine it is told of is busy", async () => {
		let short: string | undefined = "CPU some avg60 was 61.7, at or past 40";
		const child = wired(async () => "the host's code differs", {
			roomShort: async () => short,
		});
		child.holds("busy");
		await child.timers.fire();
		expect(child.rolled).toEqual([]);
		short = undefined;
		await child.timers.fire();
		expect(child.rolled).toEqual(["busy"]);
	});

	it("holds its roll on the CPU's pressure when it isn't told how to read the machine", async () => {
		const timers = manualTimers();
		const rolled: string[] = [];
		cpu.short = "CPU some avg60 was 64.7, at or past 40";
		try {
			rollChildWhenStale({
				version: NO_INSTALL,
				moved: async () => "moved",
				host: () => ({ roll: () => rolled.push("rolled") }),
				stopped: new Promise(() => undefined),
				report: () => undefined,
				lookMs: 1,
				after: timers.after,
				bornAt: 0,
				now: () => ROLL_ONLY_AFTER_MS,
				spreadMs: 0,
			});
			await timers.fire();
			expect(rolled, "busy").toEqual([]);
			cpu.short = undefined;
			await timers.fire();
			expect(rolled).toEqual(["rolled"]);
		} finally {
			cpu.short = undefined;
		}
	});

	it("draws its spread at random across ten minutes when it isn't told one", async () => {
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		try {
			const timers = manualTimers();
			rollChildWhenStale({
				version: NO_INSTALL,
				moved: async () => "moved",
				host: () => undefined,
				stopped: new Promise(() => undefined),
				report: () => undefined,
				lookMs: 1,
				after: timers.after,
				bornAt: 0,
				now: () => ROLL_ONLY_AFTER_MS,
				roomShort: async () => undefined,
			});
			await timers.fire();
			expect(ROLL_SPREAD_MS, "ten minutes").toBe(10 * 60_000);
			expect(timers.due.map(({ ms }) => ms)).toEqual([ROLL_SPREAD_MS / 2]);
		} finally {
			random.mockRestore();
		}
	});

	for (const how of ["resolve", "reject"] as const)
		it(`stops looking once the child's host stops, as it does when it ${how}s`, async () => {
			const child = wired(async () => undefined);
			expect(child.timers.due).toHaveLength(1);
			child.end(how);
			await new Promise((resolve) => setImmediate(resolve));
			expect(child.timers.due).toEqual([]);
		});
});
