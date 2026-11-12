/**
 * What Joel put on top, said to every session as it next works, and
 * counted as each one reads it.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	onTopReader,
	readsOf,
} from "../../../extensions/quest-workflow/on-top.ts";

/** 09:12 in Toronto on Saturday 14 November 2026. */
const SATURDAY = Date.parse("2026-11-14T14:12:00.000Z");
const DAY_MS = 86_400_000;
const ZONE = "America/Toronto";

const TOP = {
	quests: [
		{ id: "QEST-20261101-WJATIN", title: "Deploy v3" },
		{ id: "QEST-20261101-WM4KSZ", title: "Aquifer Part Deux" },
	],
	why: "ship by Friday; everything else yields",
	until: "2026-11-20",
	at: "2026-11-14T14:12:00.000Z",
	by: "joel",
};

function folder(): { file: string; reads: string } {
	const root = mkdtempSync(join(tmpdir(), "on-top-"));
	return { file: join(root, "top.json"), reads: join(root, "top-reads") };
}

function reader(
	where: { file: string; reads: string },
	session: string,
	now: () => number = () => SATURDAY,
) {
	return onTopReader({ ...where, session: () => session, now, zone: ZONE });
}

describe("what is on top", () => {
	it("says the quests, why in his words, and until when", () => {
		const where = folder();
		writeFileSync(where.file, JSON.stringify(TOP));
		const said = reader(where, "s1")();
		expect(said, "the standing text").toContain(
			"Deploy v3 (QEST-20261101-WJATIN), Aquifer Part Deux (QEST-20261101-WM4KSZ)",
		);
		expect(said).toContain('"ship by Friday; everything else yields"');
		expect(said).toContain("until Fri 20 Nov");
		expect(said).toContain("Joel put these on top at 09:12 on Sat 14 Nov");
	});

	it("says nothing when nothing is on top", () => {
		expect(reader(folder(), "s1")(), "no file").toBeNull();
	});

	it("lapses the day after its end", () => {
		const where = folder();
		writeFileSync(where.file, JSON.stringify(TOP));
		const friday = reader(where, "s1", () => SATURDAY + 6 * DAY_MS);
		const later = reader(where, "s1", () => SATURDAY + 7 * DAY_MS);
		expect(
			[friday() === null, later()],
			"said on its last day, gone the day after",
		).toEqual([false, null]);
	});

	it("holds what it last read while the file is half written", () => {
		const where = folder();
		writeFileSync(where.file, JSON.stringify(TOP));
		const read = reader(where, "s1");
		const before = read();
		writeFileSync(where.file, '{"quests": [');
		expect([before === null, read() === before], "the last whole file").toEqual(
			[false, true],
		);
	});

	// 85PKB2 on #1404: a whole file that names no quest takes the top
	// down; only one that doesn't parse is plausibly half written.
	it("takes the top down when a whole file names no quest", () => {
		const where = folder();
		writeFileSync(where.file, JSON.stringify(TOP));
		const read = reader(where, "s1");
		const before = read();
		writeFileSync(where.file, JSON.stringify({ ...TOP, quests: [] }));
		expect([before === null, read()], "said, then nothing").toEqual([
			false,
			null,
		]);
	});

	it("keeps only the newest top's reads", () => {
		const where = folder();
		writeFileSync(where.file, JSON.stringify(TOP));
		const read = reader(where, "s1");
		read();
		const next = { ...TOP, at: "2026-11-15T12:00:00.000Z" };
		writeFileSync(where.file, JSON.stringify(next));
		read();
		expect(
			[
				existsSync(join(where.reads, "2026-11-14T14-12-00-000Z")),
				readsOf(where.reads, next.at),
			],
			"the old top's folder gone, the new one read once",
		).toEqual([false, 1]);
	});

	it("counts each session once as it reads, for the receipt", () => {
		const where = folder();
		writeFileSync(where.file, JSON.stringify(TOP));
		reader(where, "s1")();
		reader(where, "s1")();
		reader(where, "s2")();
		expect(readsOf(where.reads, TOP.at), "two sessions read it").toBe(2);
	});

	it("starts the count again for a new top", () => {
		const where = folder();
		writeFileSync(where.file, JSON.stringify(TOP));
		reader(where, "s1")();
		const next = { ...TOP, at: "2026-11-15T12:00:00.000Z" };
		writeFileSync(where.file, JSON.stringify(next));
		expect(readsOf(where.reads, next.at), "nobody has read the new one").toBe(
			0,
		);
	});
});
