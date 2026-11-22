import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newRunId } from "../../../../lib/core/review/ask/run.ts";
import {
	awaitCouncilStart,
	COUNCIL_START_SPACING_MS,
	claimCouncilStart,
	newestRosterStartIn,
} from "../../../../lib/core/review/ask/start-spacing.ts";

const AT = new Date("2026-11-22T09:00:00.000Z");
const later = (ms: number) => new Date(AT.getTime() + ms);
const SPACING = COUNCIL_START_SPACING_MS;

let folder: string;
let path: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "council-starts-"));
	path = join(folder, "starts", "last.json");
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

const kept = () => JSON.parse(readFileSync(path, "utf8"));

describe("spacing council starts on one machine", () => {
	it("starts the first at once, and keeps its slot for the next to read", async () => {
		const slot = await claimCouncilStart(path, {
			by: "A2VLJN",
			change: "o/r#1",
			now: AT,
		});

		expect(slot.ahead, "nothing to wait behind").toBe(0);
		expect(slot.startAt).toEqual(AT);
		expect(kept()).toEqual({
			startAt: AT.toISOString(),
			by: "A2VLJN",
			change: "o/r#1",
		});
	});

	it("gives a start inside the spacing the slot a spacing after the last, naming whose", async () => {
		await claimCouncilStart(path, { by: "A2VLJN", change: "o/r#1", now: AT });

		const slot = await claimCouncilStart(path, {
			by: "ISXEG8",
			change: "o/r#2",
			now: later(60_000),
		});

		expect(slot.startAt).toEqual(later(SPACING));
		expect(slot.ahead, "next in line").toBe(0);
		expect(slot.behind).toEqual({ by: "A2VLJN", change: "o/r#1" });
		expect(kept().startAt, "the next claim waits behind this one").toBe(
			later(SPACING).toISOString(),
		);
	});

	it("starts at once once the spacing has passed", async () => {
		await claimCouncilStart(path, { by: "A2VLJN", change: "o/r#1", now: AT });

		const slot = await claimCouncilStart(path, {
			by: "ISXEG8",
			change: "o/r#2",
			now: later(SPACING),
		});

		expect(slot.ahead).toBe(0);
		expect(slot.startAt).toEqual(later(SPACING));
	});

	// 22 November, 03:44 to 04:00: starts every few minutes, because each
	// session read the mesh and saw no start before it made its own.
	it("gives claims made at once slots a spacing apart, in the order they took the lock", async () => {
		const slots = await Promise.all(
			["A2VLJN", "ISXEG8", "85PKB2", "04TNWT"].map((by) =>
				claimCouncilStart(path, { by, change: `o/r#${by}`, now: AT }),
			),
		);

		const times = slots.map((slot) => slot.startAt.getTime() - AT.getTime());
		expect([...times].sort((a, b) => a - b)).toEqual([
			0,
			SPACING,
			2 * SPACING,
			3 * SPACING,
		]);
		expect(
			slots.map((slot) => slot.ahead).sort(),
			"each says how many rounds still to start come first",
		).toEqual([0, 0, 1, 2]);
	});

	it("counts the rounds ahead of a claim made partway through a spacing", async () => {
		await claimCouncilStart(path, { by: "A2VLJN", change: "o/r#1", now: AT });
		await claimCouncilStart(path, { by: "ISXEG8", change: "o/r#2", now: AT });

		const slot = await claimCouncilStart(path, {
			by: "85PKB2",
			change: "o/r#3",
			now: later(60_000),
		});

		expect(slot.startAt).toEqual(later(2 * SPACING));
		expect(slot.ahead, "only o/r#2 is still to start").toBe(1);
	});

	it("keeps its spacing from a round started without a slot", async () => {
		const slot = await claimCouncilStart(path, {
			by: "ISXEG8",
			change: "o/r#2",
			now: later(60_000),
			startedElsewhereAt: AT,
		});

		expect(slot.startAt).toEqual(later(SPACING));
		expect(slot.behind, "nobody named, since no slot was kept").toBeUndefined();
	});

	it("names no kept slot's round when a later start read elsewhere set the wait", async () => {
		await claimCouncilStart(path, { by: "A2VLJN", change: "o/r#1", now: AT });

		const slot = await claimCouncilStart(path, {
			by: "ISXEG8",
			change: "o/r#2",
			now: later(SPACING + 60_000),
			startedElsewhereAt: later(SPACING),
		});

		expect(slot.startAt).toEqual(later(2 * SPACING));
		expect(slot.behind).toBeUndefined();
	});

	it("waits behind no slot a clock moved back put hours ahead, nor a record it can't read", async () => {
		await claimCouncilStart(path, {
			by: "A2VLJN",
			change: "o/r#1",
			now: later(3 * 60 * 60_000),
		});
		expect(
			(
				await claimCouncilStart(path, {
					by: "ISXEG8",
					change: "o/r#2",
					now: AT,
				})
			).ahead,
			"a clock that moved back holds nobody",
		).toBe(0);

		writeFileSync(path, "{ cut short");
		expect(
			(
				await claimCouncilStart(path, {
					by: "85PKB2",
					change: "o/r#3",
					now: later(1000),
				})
			).ahead,
			"a record cut short holds nobody",
		).toBe(0);
	});
});

describe("waiting for a start", () => {
	it("starts at once, saying nothing, when nothing is ahead", async () => {
		const waited = await awaitCouncilStart(path, {
			by: "A2VLJN",
			change: "o/r#1",
			now: new Date(),
		});

		expect(waited).toEqual({});
	});

	it("waits for its slot and says its place and start time", async () => {
		const now = new Date();
		await claimCouncilStart(path, { by: "A2VLJN", change: "o/r#1", now });

		const waited = await awaitCouncilStart(path, {
			by: "ISXEG8",
			change: "o/r#2",
			now,
			spacingMs: 300,
		});

		// Measured against its slot, not the call, so a slow first claim
		// on a loaded machine can't fail it.
		expect(Date.now(), "it waited for its slot").toBeGreaterThanOrEqual(
			now.getTime() + 300,
		);
		expect(waited.waited).toContain(
			`at ${new Date(now.getTime() + 300).toISOString().slice(11, 19)} UTC, next in line, behind o/r#1 (asked by A2VLJN)`,
		);
		expect(waited.cancelled).toBeUndefined();
	});

	it("says it was stopped, starting nothing, and gives its slot back when given up while it waits", async () => {
		const now = new Date();
		await claimCouncilStart(path, { by: "A2VLJN", change: "o/r#1", now });
		const giving = new AbortController();

		const waiting = awaitCouncilStart(
			path,
			{ by: "ISXEG8", change: "o/r#2", now },
			giving.signal,
		);
		// Given up once it holds its slot and sleeps, not before.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(kept().by, "it took its slot").toBe("ISXEG8");
		giving.abort();

		const waited = await waiting;
		expect(waited.cancelled).toContain("stopped while it waited");
		expect(waited.waited).toBeUndefined();
		expect(kept().by, "the slot before it is the last again").toBe("A2VLJN");
	});

	it("leaves its slot as a gap when given up behind a later claim", async () => {
		const now = new Date();
		await claimCouncilStart(path, { by: "A2VLJN", change: "o/r#1", now });
		const giving = new AbortController();
		const waiting = awaitCouncilStart(
			path,
			{ by: "ISXEG8", change: "o/r#2", now },
			giving.signal,
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		await claimCouncilStart(path, { by: "85PKB2", change: "o/r#3", now });
		giving.abort();

		await waiting;
		expect(kept().by, "the later claim keeps its slot").toBe("85PKB2");
	});

	it("takes no slot when stopped before it asks", async () => {
		const giving = new AbortController();
		giving.abort();

		const waited = await awaitCouncilStart(
			path,
			{ by: "ISXEG8", change: "o/r#2", now: new Date() },
			giving.signal,
		);

		expect(waited.cancelled).toContain("stopped");
		expect(() => kept(), "nothing kept").toThrow();
	});
});

describe("the newest roster round in the transcripts", () => {
	it("reads the newest council, stack or critique, passing over judges and audits", async () => {
		const runs = join(folder, "runs");
		// Named as rounds name their folders, so a drift there shows here.
		for (const name of [
			newRunId("council", new Date("2026-11-22T17:41:17.298Z"), 2),
			newRunId("stack", new Date("2026-11-22T17:43:00.000Z"), 1),
			newRunId("judge", new Date("2026-11-22T17:50:00.000Z"), 1),
			newRunId("audit", new Date("2026-11-22T17:51:00.000Z"), 1),
			"notes",
		]) {
			mkdirSync(join(runs, name), { recursive: true });
		}

		expect(await newestRosterStartIn(runs)).toEqual(
			new Date("2026-11-22T17:43:00.000Z"),
		);
		expect(
			await newestRosterStartIn(join(folder, "none")),
			"no folder, no start",
		).toBeUndefined();
	});
});
