/**
 * Whether a Mac has memory to start a council: the queue's own rule
 * over the swap history the machine shares.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	boundedRunner,
	MAC_READING_SERVES_MS,
	type MacFigures,
	type MacSources,
	macFiguresFrom,
	macFiguresNow,
	macRoundRoom,
	PROGRAM_TIMEOUT_MS,
	runBounded,
	sharedReading,
	UNJUDGED_LOOK_GAP_MS,
	UNJUDGED_WAIT_MS,
} from "../../../../lib/core/review/ask/mac-room.ts";
import {
	historyInMemory,
	type MemoryFigures,
	SWAPPING_MS,
} from "../../../../lib/internal/priority/room-darwin.ts";

/** A Mac with room: normal pressure, half its memory available. */
const roomy: MemoryFigures = {
	availablePercent: 50,
	pressureLevel: 1,
	swapouts: 1000,
};

/** A Mac whose figures are `read`, at a time the test moves. */
function mac(read: () => MacFigures | Error): MacSources & {
	advance(ms: number): void;
	readonly history: ReturnType<typeof historyInMemory>;
} {
	let now = 1_000_000;
	const clock = () => now;
	const history = historyInMemory();
	return {
		reading: sharedReading(
			async () => {
				const figures = read();
				if (figures instanceof Error) throw figures;
				return figures;
			},
			clock,
			history,
		),
		clock,
		unjudged: { since: undefined },
		history,
		advance: (ms) => {
			now += ms;
		},
	};
}

/** How often a waiting round looks at its room. */
const LOOK_EVERY_MS = 15_000;

/**
 * Moves the clock `ms` on with `room` looking every 15 s, as a waiting
 * round does, answering what its last look said.
 */
async function lookFor(
	room: ReturnType<typeof macRoundRoom>,
	sources: ReturnType<typeof mac>,
	ms: number,
): Promise<string | undefined> {
	let said: string | undefined;
	for (let left = ms; left > 0; left -= LOOK_EVERY_MS) {
		sources.advance(Math.min(left, LOOK_EVERY_MS));
		said = await room.short();
	}
	return said;
}

/**
 * What `found` gives once it gives anything, asking at each turn of the
 * event loop for at most `ms`.
 */
async function within<T>(ms: number, found: () => T | undefined): Promise<T> {
	const until = Date.now() + ms;
	for (;;) {
		const value = found();
		if (value !== undefined) return value;
		if (Date.now() > until) throw new Error(`nothing within ${ms} ms`);
		await new Promise((settle) => setImmediate(settle));
	}
}

/** Whether process `pid` still runs. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("whether a Mac has memory for a round", () => {
	it("waits for a reading a minute old, then starts while nothing says short", async () => {
		const sources = mac(() => roomy);
		const room = macRoundRoom(sources);
		expect(await room.short()).toContain("a reading a minute old");
		sources.advance(SWAPPING_MS);
		expect(await room.short()).toBeUndefined();
		expect(room.startedUnjudged()).toBeUndefined();
	});

	it("is short at warning pressure, saying the level", async () => {
		const room = macRoundRoom(mac(() => ({ ...roomy, pressureLevel: 2 })));
		expect(await room.short()).toContain("pressure level is 2");
	});

	it("is short while it swapped out within the last minute", async () => {
		let swapouts = 1000;
		const sources = mac(() => ({ ...roomy, swapouts }));
		const room = macRoundRoom(sources);
		await room.short();
		sources.advance(SWAPPING_MS / 2);
		swapouts = 1500;
		expect(await room.short()).toBe(
			"it swapped out 500 pages in the last 30 s",
		);
	});

	it("holds a round as long as it reads short, with no cap", async () => {
		const sources = mac(() => ({ ...roomy, availablePercent: 34 }));
		const room = macRoundRoom(sources);
		expect(await room.short()).toContain("34% of its memory is available");
		sources.advance(UNJUDGED_WAIT_MS * 3);
		expect(await room.short()).toContain("34% of its memory is available");
		expect(room.startedUnjudged()).toBeUndefined();
	});

	it("reads the baseline another session left in the shared history", async () => {
		const sources = mac(() => roomy);
		sources.history.save([{ at: 1_000_000 - SWAPPING_MS, swapouts: 1000 }]);
		expect(await macRoundRoom(sources).short()).toBeUndefined();
	});

	it("waits on figures it can't read for at most ten minutes, then starts and says why", async () => {
		const sources = mac(() => new Error("sysctl timed out"));
		const room = macRoundRoom(sources);
		expect(await room.short()).toBe(
			"this Mac's memory can't be read (sysctl timed out)",
		);
		expect(await lookFor(room, sources, UNJUDGED_WAIT_MS - 1)).toBeDefined();
		sources.advance(1);
		expect(await room.short()).toBeUndefined();
		expect(room.startedUnjudged()).toBe(
			"It started though this Mac's room couldn't be judged for 10 minutes: this Mac's memory can't be read (sysctl timed out).",
		);
	});

	it("counts the wait for a baseline toward the same cap", async () => {
		// A history another writer keeps emptying never gives the swap rule
		// a reading a minute old to compare against: each reading here
		// finds the history emptied before it joins.
		const sources = mac(() => {
			sources.history.save([]);
			return roomy;
		});
		const room = macRoundRoom(sources);
		expect(await room.short()).toContain("a reading a minute old");
		expect(await lookFor(room, sources, UNJUDGED_WAIT_MS)).toBeUndefined();
		expect(room.startedUnjudged()).toContain("a reading a minute old");
	});

	it("starts the wait again for the next round once the cap lets one start", async () => {
		const sources = mac(() => new Error("gone"));
		const first = macRoundRoom(sources);
		await first.short();
		expect(await lookFor(first, sources, UNJUDGED_WAIT_MS)).toBeUndefined();
		expect(first.startedUnjudged(), "the first round started").toBeDefined();
		sources.advance(MAC_READING_SERVES_MS);
		const next = macRoundRoom(sources);
		expect(await next.short(), "the next round waits its own").toContain(
			"can't be read",
		);
		expect(next.startedUnjudged()).toBeUndefined();
	});

	// The council of 27 November: a look the cap let through, whose round
	// then waited its turn behind another, spent the wait all the same,
	// so the round first in line waited ten minutes more.
	it("spends nothing at a look the cap let through whose round didn't start", async () => {
		const sources = mac(() => new Error("gone"));
		const behind = macRoundRoom(sources);
		const first = macRoundRoom(sources);
		await first.short();
		expect(await lookFor(behind, sources, UNJUDGED_WAIT_MS)).toBeUndefined();
		expect(await first.short(), "the round first in line may start").toBe(
			undefined,
		);
		expect(first.startedUnjudged()).toContain("gone");
	});

	// A round that waited behind a running round, or came after none
	// looked for a while, would otherwise start at its first look with
	// no baseline, on a clock some earlier wait left running.
	it("starts the wait over after a gap no round looked in", async () => {
		const sources = mac(() => new Error("gone"));
		const room = macRoundRoom(sources);
		await lookFor(room, sources, UNJUDGED_WAIT_MS / 2);
		sources.advance(UNJUDGED_LOOK_GAP_MS + 1);
		expect(await room.short(), "the wait starts over").toContain("gone");
		expect(
			await lookFor(room, sources, UNJUDGED_WAIT_MS - LOOK_EVERY_MS),
		).toContain("gone");
		expect(await lookFor(room, sources, LOOK_EVERY_MS)).toBeUndefined();
	});

	it("stops saying it started unjudged once a later look gives a verdict", async () => {
		let broken = true;
		const sources = mac(() => (broken ? new Error("gone") : roomy));
		const room = macRoundRoom(sources);
		await room.short();
		expect(await lookFor(room, sources, UNJUDGED_WAIT_MS)).toBeUndefined();
		expect(room.startedUnjudged()).toContain("gone");
		broken = false;
		sources.advance(MAC_READING_SERVES_MS);
		await room.short();
		sources.advance(SWAPPING_MS);
		expect(await room.short()).toBeUndefined();
		expect(room.startedUnjudged()).toBeUndefined();
	});

	it("is short when a program ran out of time, with no cap, as a Mac swapping hard makes it", async () => {
		const sources = mac(() => ({
			availablePercent: Number.NaN,
			pressureLevel: Number.NaN,
			swapouts: 1000,
			slow: ["sysctl"],
		}));
		const room = macRoundRoom(sources);
		expect(await room.short()).toBe(
			"sysctl took past 5 s to answer, as on a Mac swapping hard",
		);
		sources.advance(UNJUDGED_WAIT_MS * 3);
		expect(await room.short()).toContain("took past 5 s");
		expect(room.startedUnjudged()).toBeUndefined();
	});

	it("is short on warning pressure though vm_stat failed", async () => {
		const room = macRoundRoom(
			mac(() => ({
				availablePercent: 50,
				pressureLevel: 4,
				swapouts: Number.NaN,
				failed: ["/usr/bin/vm_stat failed (1)"],
			})),
		);
		expect(await room.short()).toContain("pressure level is 4");
	});

	it("counts figures sysctl didn't give as unread, not as 0, saying why", async () => {
		const room = macRoundRoom(
			mac(() => ({
				...macFiguresFrom("", "Swapouts: 7.\n"),
				failed: ["/usr/sbin/sysctl failed (ENOENT)"],
			})),
		);
		expect(await room.short()).toBe(
			"this Mac's memory can't be read (no figure for availablePercent, pressureLevel: /usr/sbin/sysctl failed (ENOENT))",
		);
	});

	it("shares the wait between the rounds of a process", async () => {
		const sources = mac(() => new Error("gone"));
		const earlier = macRoundRoom(sources);
		await earlier.short();
		await lookFor(earlier, sources, UNJUDGED_WAIT_MS - LOOK_EVERY_MS);
		sources.advance(LOOK_EVERY_MS);
		const later = macRoundRoom(sources);
		expect(await later.short()).toBeUndefined();
		expect(later.startedUnjudged()).toContain("gone");
	});

	it("counts a swap count vm_stat didn't give as unread, not as none", async () => {
		const figures = macFiguresFrom(
			"kern.memorystatus_level: 50\nkern.memorystatus_vm_pressure_level: 1\n",
			"Pages free: 1.\n",
		);
		const room = macRoundRoom(mac(() => figures));
		expect(await room.short()).toBe(
			"this Mac's memory can't be read (no figure for swapouts)",
		);
	});

	it("reads the figures from sysctl's and vm_stat's answers", () => {
		expect(
			macFiguresFrom(
				"kern.memorystatus_level: 41\nkern.memorystatus_vm_pressure_level: 2\n",
				"Pageouts: 9.\nSwapouts:                     1234.\n",
			),
		).toEqual({ availablePercent: 41, pressureLevel: 2, swapouts: 1234 });
	});

	it("starts the wait again once a reading gives a verdict", async () => {
		let broken = true;
		const sources = mac(() => (broken ? new Error("gone") : roomy));
		sources.history.save([{ at: 1_000_000 - SWAPPING_MS, swapouts: 1000 }]);
		const room = macRoundRoom(sources);
		await room.short();
		sources.advance(UNJUDGED_WAIT_MS - MAC_READING_SERVES_MS);
		// The first baseline is too old by now to date a window, so the
		// verdict needs one a minute before this reading.
		sources.history.save([
			{ at: sources.clock() - SWAPPING_MS, swapouts: roomy.swapouts },
		]);
		broken = false;
		expect(await room.short()).toBeUndefined();
		broken = true;
		sources.advance(MAC_READING_SERVES_MS);
		expect(await room.short()).toContain("can't be read");
	});
});

describe("one reading of a Mac shared by its rounds", () => {
	it("serves one reading while it is fresh, dated when it was read", async () => {
		let now = 0;
		let reads = 0;
		const reading = sharedReading(
			async () => {
				reads += 1;
				now += 5;
				return roomy;
			},
			() => now,
			historyInMemory(),
		);
		expect((await reading()).at).toBe(5);
		now += MAC_READING_SERVES_MS - 10;
		expect((await reading()).at).toBe(5);
		now += 10;
		expect((await reading()).at).toBe(MAC_READING_SERVES_MS + 10);
		expect(reads).toBe(2);
	});

	it("asks once for rounds that look while a reading is under way", async () => {
		let reads = 0;
		const reading = sharedReading(
			async () => {
				reads += 1;
				return roomy;
			},
			() => 0,
			historyInMemory(),
		);
		await Promise.all([reading(), reading(), reading()]);
		expect(reads).toBe(1);
	});

	it("serves a failure as long as a reading, so a Mac that can't answer isn't asked at every look", async () => {
		let now = 0;
		let reads = 0;
		const reading = sharedReading(
			async () => {
				reads += 1;
				throw new Error("vm_stat timed out");
			},
			() => now,
			historyInMemory(),
		);
		await expect(reading()).rejects.toThrow("vm_stat timed out");
		await expect(reading()).rejects.toThrow("vm_stat timed out");
		expect(reads).toBe(1);
		now += MAC_READING_SERVES_MS;
		await expect(reading()).rejects.toThrow("vm_stat timed out");
		expect(reads).toBe(2);
	});

	it("adds each reading to the shared history", async () => {
		const history = historyInMemory();
		const reading = sharedReading(
			async () => roomy,
			() => 7,
			history,
		);
		expect((await reading()).seen).toEqual([{ at: 7, swapouts: 1000 }]);
		expect(history.load()).toEqual([{ at: 7, swapouts: 1000 }]);
	});
});

describe("a Mac's figures, each program read apart", () => {
	const SYSCTL =
		"kern.memorystatus_level: 41\nkern.memorystatus_vm_pressure_level: 1\n";

	it("keeps what sysctl said when vm_stat failed, naming the failure", async () => {
		const figures = await macFiguresNow(async (path) =>
			path.endsWith("sysctl")
				? { text: SYSCTL }
				: { failed: `${path} failed (1)` },
		);
		expect(figures.availablePercent).toBe(41);
		expect(figures.swapouts).toBeNaN();
		expect(figures.failed).toEqual(["/usr/bin/vm_stat failed (1)"]);
		expect(figures.slow).toBeUndefined();
	});

	it("names a program that ran out of time as slow", async () => {
		const figures = await macFiguresNow(async (path) =>
			path.endsWith("vm_stat") ? { slow: true } : { text: SYSCTL },
		);
		expect(figures.slow).toEqual(["vm_stat"]);
	});

	it("asks Apple's own programs by their paths", async () => {
		const asked: string[] = [];
		await macFiguresNow(async (path) => {
			asked.push(path);
			return { text: "" };
		});
		expect(asked.sort()).toEqual(["/usr/bin/vm_stat", "/usr/sbin/sysctl"]);
	});
});

describe("a program run with a bound", () => {
	it("gives what it printed", async () => {
		expect(await runBounded("/bin/echo", ["hello"])).toEqual({
			text: "hello\n",
		});
	});

	it("answers slow at its bound for a child the kill can't end yet", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			// The child's own timeout runs on Node's internal timers, which
			// the test doesn't fake, so only the bound can answer here.
			const answer = runBounded("/bin/sleep", ["2"]);
			await vi.advanceTimersByTimeAsync(PROGRAM_TIMEOUT_MS + 1_000);
			expect(await answer).toEqual({ slow: true });
		} finally {
			vi.useRealTimers();
		}
	});

	it("names a program that couldn't run, without its raw error", async () => {
		expect(await runBounded("/nonexistent/program", [])).toEqual({
			failed: "/nonexistent/program failed (ENOENT)",
		});
	});

	it("ends a child that sits out a TERM once its time is up, answering slow", async () => {
		const dir = mkdtempSync(join(tmpdir(), "run-bounded-"));
		const pidFile = join(dir, "pid");
		try {
			// Ignores SIGTERM, as a reader stuck on a swapping Mac may, and
			// would sleep 30 s: only a KILL at the timeout ends it sooner,
			// and well inside the bound, so the kill is what answers.
			const answer = boundedRunner(500, 10_000)("/bin/sh", [
				"-c",
				`echo $$ > ${pidFile}; trap "" TERM; exec /bin/sleep 30`,
			]);
			expect(await answer).toEqual({ slow: true });
			const pid = Number(readFileSync(pidFile, "utf8").trim());
			const ended = await within(3_000, () => (alive(pid) ? undefined : true));
			expect(ended, `the child ${pid} still runs past its timeout`).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe.runIf(process.platform === "darwin")("this Mac's own figures", () => {
	// Past the programs' own 5 s timeout and its bound, so a slow Mac
	// answers slow rather than failing the test's budget.
	it("reads every figure the room needs", { timeout: 15_000 }, async () => {
		const figures = await macFiguresNow();
		expect(figures.availablePercent).toBeGreaterThanOrEqual(0);
		expect(figures.pressureLevel).toBeGreaterThanOrEqual(0);
		expect(figures.swapouts).toBeGreaterThanOrEqual(0);
	});
});
