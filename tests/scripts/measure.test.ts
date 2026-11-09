import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BUSY_TRIES,
	strayArguments,
	whileBusy,
} from "../../scripts/measure.ts";

/** An error shaped as the sqlite driver throws one for a held lock. */
function locked(): Error {
	return Object.assign(new Error("SQLITE_BUSY: database is locked"), {
		code: "SQLITE_BUSY",
	});
}

/** An attempt that meets a locked ledger `times` times, then answers. */
function lockedFor(times: number): () => Promise<string> {
	let runs = 0;
	return async () => {
		runs++;
		if (runs <= times) throw locked();
		return `answered on run ${runs}`;
	};
}

describe("a measure meeting a locked ledger", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("runs again after a longer wait each time, until the lock is gone", async () => {
		const waits: number[] = [];
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const answer = await whileBusy(lockedFor(2), async (ms) => {
			waits.push(ms);
		});
		expect(answer).toBe("answered on run 3");
		expect(waits).toEqual([30_000, 60_000]);
	});

	it("gives up with the lock's error once every run met it", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		let waited = 0;
		await expect(
			whileBusy(lockedFor(BUSY_TRIES), async () => {
				waited++;
			}),
		).rejects.toThrow("SQLITE_BUSY");
		expect(waited).toBe(BUSY_TRIES - 1);
	});

	it("throws any other error at once, without waiting", async () => {
		let waited = 0;
		await expect(
			whileBusy(
				async () => {
					throw new Error("no such table: turns");
				},
				async () => {
					waited++;
				},
			),
		).rejects.toThrow("no such table");
		expect(waited).toBe(0);
	});
});

describe("the measure's arguments", () => {
	it("takes its options, with the values two of them need", () => {
		expect(strayArguments([])).toEqual([]);
		expect(strayArguments(["--out", "/tmp/w.md", "--top", "5"])).toEqual([]);
		expect(strayArguments(["--week", "--top", "5"])).toEqual([]);
	});

	it("names what it does not take, so a mistyped run is refused", () => {
		expect(strayArguments(["--help"])).toEqual(["--help"]);
		expect(strayArguments(["--out"])).toEqual(["--out"]);
		expect(strayArguments(["--top", "--out", "x"])).toEqual(["--top"]);
		expect(strayArguments(["--day"])).toEqual(["--day"]);
	});
});
