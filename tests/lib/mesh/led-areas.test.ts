import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type KeptLanding,
	keepLanding,
	kept,
} from "../../../lib/mesh/landing-history.ts";
import {
	LED_AREAS_FILE,
	ledAreas,
	ledAreasAt,
} from "../../../lib/mesh/led-areas.ts";
import { MOST_SUBJECTS } from "../../../lib/mesh/subjects.ts";

const NOW = Date.parse("2026-11-25T06:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

let n = 0;
/** A merge `days` ago by `quest`, touching `areas` of the harness. */
function merge(
	quest: string | undefined,
	areas: readonly string[] | undefined,
	days = 0,
	repo = "Jitsusama/agentic-harness.pi",
): KeptLanding {
	n++;
	return kept(
		{
			at: new Date(NOW - days * DAY).toISOString(),
			ref: `${repo.slice(repo.indexOf("/") + 1)}#${n}`,
			what: `change ${n}`,
			url: `https://github.com/${repo}/pull/${n}`,
			...(areas ? { areas } : {}),
		},
		{ session: `S${n}`, ...(quest ? { quest } : {}), repo },
	);
}

describe("the areas each quest led in its landings", () => {
	it("says an area its quest landed twice, as the repository's name and the area", () => {
		expect(
			ledAreas(
				[
					merge("QEST-A", ["extensions/review-integration"]),
					merge("QEST-A", ["extensions/review-integration"], 1),
				],
				NOW,
			),
		).toEqual({
			"QEST-A": ["agentic-harness.pi:extensions/review-integration"],
		});
	});

	it("says none for an area its quest landed only once", () => {
		expect(ledAreas([merge("QEST-A", ["lib/mesh"])], NOW)).toEqual({});
	});

	it("leaves an area to the quests landing at least half as much as its most", () => {
		const landings = [
			...[0, 1, 2, 3].map((d) => merge("QEST-A", ["lib/mesh"], d)),
			...[0, 1, 2].map((d) => merge("QEST-B", ["lib/mesh"], d)),
			...[0, 1].map((d) => merge("QEST-C", ["lib/mesh"], d + 10)),
		];
		expect(ledAreas(landings, NOW)).toEqual({
			"QEST-A": ["agentic-harness.pi:lib/mesh"],
			"QEST-B": ["agentic-harness.pi:lib/mesh"],
		});
	});

	it("weighs a recent landing above an older one, and none past two weeks", () => {
		const landings = [
			...[13, 13, 13].map((d) => merge("QEST-OLD", ["lib/ui"], d)),
			...[0, 0].map((d) => merge("QEST-NEW", ["lib/ui"], d)),
			...[15, 15].map((d) => merge("QEST-GONE", ["lib/budget"], d)),
		];
		expect(ledAreas(landings, NOW)).toEqual({
			"QEST-NEW": ["agentic-harness.pi:lib/ui"],
		});
	});

	it("credits only the quest that landed it, and passes over a landing missing its quest, repository or areas", () => {
		const landings = [
			merge(undefined, ["lib/ui"]),
			merge(undefined, ["lib/ui"]),
			merge("QEST-A", undefined),
			merge("QEST-A", undefined),
			kept(
				{
					at: new Date(NOW).toISOString(),
					ref: "PLAN-1#1",
					what: "item",
					areas: ["lib/ui"],
				},
				{ session: "S", quest: "QEST-A" },
			),
		];
		expect(ledAreas(landings, NOW)).toEqual({});
	});

	it("puts the areas a quest leads most first, and says at most a cell's subjects", () => {
		const areas = Array.from(
			{ length: MOST_SUBJECTS + 3 },
			(_, i) => `lib/a${i}`,
		);
		const landings = [
			...[0, 1, 2].map((d) => merge("QEST-A", ["lib/most"], d)),
			...[0, 1].map((d) => merge("QEST-A", areas, d)),
		];
		const said = ledAreas(landings, NOW)["QEST-A"] ?? [];
		expect(said[0]).toBe("agentic-harness.pi:lib/most");
		expect(said).toHaveLength(MOST_SUBJECTS);
	});
});

describe("the led areas kept beside the landings", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "led-areas-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("are written with each landing kept, for a peer to read its quest's", async () => {
		await keepLanding(dir, merge("QEST-A", ["lib/mesh"], 1), NOW);
		expect(ledAreasAt(dir, "QEST-A")).toEqual([]);
		await keepLanding(dir, merge("QEST-A", ["lib/mesh"]), NOW);

		expect(ledAreasAt(dir, "QEST-A")).toEqual(["agentic-harness.pi:lib/mesh"]);
		expect(ledAreasAt(dir, "QEST-B")).toEqual([]);
	});

	it("read as none when the file is missing or isn't one", () => {
		expect(ledAreasAt(dir, "QEST-A")).toEqual([]);
		writeFileSync(join(dir, LED_AREAS_FILE), "{ not json");
		expect(ledAreasAt(dir, "QEST-A")).toEqual([]);
		writeFileSync(
			join(dir, LED_AREAS_FILE),
			JSON.stringify({ v: 1, quests: { "QEST-A": [1, "x:y"] } }),
		);
		expect(ledAreasAt(dir, "QEST-A")).toEqual(["x:y"]);
	});
});
