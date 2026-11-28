/**
 * The start line's history: each start the line gives is kept a line
 * a day beside it, with when it was asked and when it started, so a
 * wait can be read back after the line has moved on.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	KEEP_DAYS,
	recordStart,
	type StartRecord,
} from "../../../../lib/core/review/ask/start-history.ts";
import { awaitCouncilStart } from "../../../../lib/core/review/ask/start-spacing.ts";

let folder: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "start-history-"));
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

/** The lines kept for `day`, parsed, or none while there is no file. */
function linesOf(day: string): StartRecord[] {
	const file = join(folder, "history", `${day}.jsonl`);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

/** Every start kept, whatever its day, in the order the days run. */
function allKept(): StartRecord[] {
	const history = join(folder, "history");
	if (!existsSync(history)) return [];
	return readdirSync(history)
		.sort()
		.flatMap((name) => linesOf(name.replace(/\.jsonl$/, "")));
}

describe("keeping the line's starts", () => {
	it("keeps each start the line gives, with when it was asked and when it started", async () => {
		const path = join(folder, "last.json");
		const claim = {
			by: "A2VLJN",
			change: "o/r#1",
			spacingMs: 600,
			lookAgainMs: 10,
			kind: "council",
		};

		await awaitCouncilStart(path, claim);
		await awaitCouncilStart(path, { ...claim, by: "ISXEG8", change: "o/r#2" });

		// The history is written beside the start, not waited for by it.
		await expect.poll(() => allKept().length, { timeout: 2_000 }).toBe(2);
		const kept = allKept();
		expect(
			kept.map((line) => line.change),
			"both starts, in order",
		).toEqual(["o/r#1", "o/r#2"]);
		const [first, second] = kept;
		expect(second?.kind).toBe("council");
		// The line spaces starts from each other, not from an ask, so the
		// second's wait is the spacing less however late it asked.
		expect(
			Date.parse(second?.startAt ?? "") - Date.parse(first?.startAt ?? ""),
			"the second started a spacing after the first",
		).toBeGreaterThanOrEqual(600 - 2);
		expect(second?.waitedMs).toBe(
			Date.parse(second?.startAt ?? "") - Date.parse(second?.askedAt ?? ""),
		);
		expect(second?.ticket).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("lets days older than it keeps go when a new day is first written", async () => {
		const history = join(folder, "history");
		mkdirSync(history, { recursive: true });
		const old = join(history, "2026-11-01.jsonl");
		const kept = join(history, "2026-11-20.jsonl");
		const other = join(history, "notes.txt");
		for (const file of [old, kept, other]) writeFileSync(file, "{}\n");

		await recordStart(folder, {
			ticket: "t",
			by: "A2VLJN",
			change: "o/r#1",
			askedAt: "2026-11-27T12:00:00.000Z",
			startAt: "2026-11-27T12:05:00.000Z",
			waitedMs: 300_000,
		});

		expect(existsSync(old), `older than ${KEEP_DAYS} days`).toBe(false);
		expect(existsSync(kept), "within the days kept").toBe(true);
		expect(existsSync(other), "not a day's file").toBe(true);
		expect(linesOf("2026-11-27")).toHaveLength(1);
	});
});
