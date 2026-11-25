import { execFileSync } from "node:child_process";
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
	LED_WITHIN_MS,
	ledAreas,
	ledAreasAt,
} from "../../../lib/mesh/led-areas.ts";
import { MOST_SUBJECTS } from "../../../lib/mesh/subjects.ts";

const NOW = Date.parse("2026-11-25T06:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

let n = 0;
/**
 * A merge `days` ago by `quest`, touching `areas` of the harness, which
 * the record of proposals says `quest` proposed.
 */
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
		() => quest,
	);
}

/** The subjects each quest led in `landings` at {@link NOW}, without when each lapses. */
function led(landings: readonly KeptLanding[]): Record<string, string[]> {
	return Object.fromEntries(
		Object.entries(ledAreas(landings, NOW)).map(([quest, leads]) => [
			quest,
			leads.map((lead) => lead.subject),
		]),
	);
}

describe("the areas each quest led in its landings", () => {
	it("says an area its quest landed twice, as the repository's name and the area", () => {
		expect(
			led([
				merge("QEST-A", ["extensions/review-integration"]),
				merge("QEST-A", ["extensions/review-integration"], 1),
			]),
		).toEqual({
			"QEST-A": ["agentic-harness.pi:extensions/review-integration"],
		});
	});

	it("says each lead lapses when its second-newest landing leaves the window", () => {
		const leads = ledAreas(
			[
				merge("QEST-A", ["lib/mesh"]),
				merge("QEST-A", ["lib/mesh"], 3),
				merge("QEST-A", ["lib/mesh"], 5),
			],
			NOW,
		);

		expect(leads).toEqual({
			"QEST-A": [
				{
					subject: "agentic-harness.pi:lib/mesh",
					until: NOW - 3 * DAY + LED_WITHIN_MS,
				},
			],
		});
	});

	// FZ9MFJ, 25 November: the harness's gate merges other cells' changes,
	// and would come to lead what they wrote.
	it("credits a merge to the quest that proposed it, not the one that merged it", () => {
		const byGate = (days: number) => ({
			...merge("QEST-GATE", ["lib/mesh"], days),
			proposedBy: "QEST-ROUTING",
		});

		expect(led([byGate(0), byGate(1)])).toEqual({
			"QEST-ROUTING": ["agentic-harness.pi:lib/mesh"],
		});
	});

	// FZ9MFJ, 25 November, on #2216: the record of proposals is each
	// machine's own, so a change proposed on the Mac and merged by the gate
	// here has no proposer known, and crediting its merger led the gate.
	it("credits nobody with a merge whose proposer no record knows", () => {
		const unknown = (days: number) => {
			const { proposedBy: _, ...landing } = merge(
				"QEST-GATE",
				["lib/mesh"],
				days,
			);
			return landing;
		};

		expect(led([unknown(0), unknown(1)])).toEqual({});
	});

	it("says none for an area its quest landed only once", () => {
		expect(led([merge("QEST-A", ["lib/mesh"])])).toEqual({});
	});

	it("leaves an area to the quests landing at least half as much as its most", () => {
		const landings = [
			...[0, 1, 2, 3].map((d) => merge("QEST-A", ["lib/mesh"], d)),
			...[0, 1, 2].map((d) => merge("QEST-B", ["lib/mesh"], d)),
			...[0, 1].map((d) => merge("QEST-C", ["lib/mesh"], d + 10)),
		];
		expect(led(landings)).toEqual({
			"QEST-A": ["agentic-harness.pi:lib/mesh"],
			"QEST-B": ["agentic-harness.pi:lib/mesh"],
		});
	});

	it("weighs a recent landing above an older one, and none past two weeks", () => {
		const landings = [
			...[13, 13, 13].map((d) => merge("QEST-OLD", ["lib/prose"], d)),
			...[0, 0].map((d) => merge("QEST-NEW", ["lib/prose"], d)),
			...[15, 15].map((d) => merge("QEST-GONE", ["lib/budget"], d)),
		];
		expect(led(landings)).toEqual({
			"QEST-NEW": ["agentic-harness.pi:lib/prose"],
		});
	});

	it("credits only the quest that landed it, and passes over a landing missing its quest, repository or areas", () => {
		const landings = [
			merge("QEST-A", ["lib/prose"]),
			merge("QEST-A", ["lib/prose"], 1),
			merge(undefined, ["lib/budget"]),
			merge(undefined, ["lib/budget"]),
			merge("QEST-B", undefined),
			merge("QEST-B", undefined),
			...[0, 1].map(() =>
				kept(
					{
						at: new Date(NOW).toISOString(),
						ref: "PLAN-20261125-C5WSJ7#1",
						what: "item",
						areas: ["lib/budget"],
					},
					{ session: "S", quest: "QEST-B" },
				),
			),
		];
		expect(led(landings)).toEqual({
			"QEST-A": ["agentic-harness.pi:lib/prose"],
		});
	});

	// The council, 25 November: the history is read from disk, and a
	// landing whose areas aren't a list would throw inside its lock.
	it("reads only the names among a landing's areas, whatever else it holds", () => {
		const odd = (areas: unknown, days: number): KeptLanding => ({
			...merge("QEST-A", undefined, days),
			areas: areas as readonly string[],
		});

		expect(
			led([odd("lib/prose", 0), odd([7, "lib/mesh"], 1), odd([null], 2)]),
		).toEqual({});
		expect(led([odd([7, "lib/mesh"], 0), odd(["lib/mesh"], 1)])).toEqual({
			"QEST-A": ["agentic-harness.pi:lib/mesh"],
		});
	});

	it("leaves out an area whose name gives routing no word", () => {
		expect(
			led([
				merge("QEST-A", ["modules/pi", "lib/mesh"]),
				merge("QEST-A", ["modules/pi", "lib/mesh"], 1),
			]),
		).toEqual({ "QEST-A": ["agentic-harness.pi:lib/mesh"] });
	});

	it("puts the areas a quest leads most first, and says at most a cell's subjects", () => {
		const areas = Array.from(
			{ length: MOST_SUBJECTS + 3 },
			(_, i) => `lib/area${i}`,
		);
		const landings = [
			...[0, 1].map((d) => merge("QEST-A", areas, d)),
			...[0, 1, 2].map((d) => merge("QEST-A", ["lib/mesh"], d)),
		];
		const said = led(landings)["QEST-A"] ?? [];
		expect(said[0]).toBe("agentic-harness.pi:lib/mesh");
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
		expect(ledAreasAt(dir, "QEST-A", NOW)).toEqual([]);
		await keepLanding(dir, merge("QEST-A", ["lib/mesh"]), NOW);

		expect(ledAreasAt(dir, "QEST-A", NOW)).toEqual([
			"agentic-harness.pi:lib/mesh",
		]);
		expect(ledAreasAt(dir, "QEST-B", NOW)).toEqual([]);
	});

	// The council, 25 November: written only when something lands, a lead
	// was said on a quiet day after the window had let it go.
	it("stop saying a lead once it has lapsed, with nothing more landed", async () => {
		await keepLanding(dir, merge("QEST-A", ["lib/mesh"], 1), NOW);
		await keepLanding(dir, merge("QEST-A", ["lib/mesh"]), NOW);
		const lapses = NOW - DAY + LED_WITHIN_MS;

		expect(ledAreasAt(dir, "QEST-A", lapses - 1)).toEqual([
			"agentic-harness.pi:lib/mesh",
		]);
		expect(ledAreasAt(dir, "QEST-A", lapses)).toEqual([]);
	});

	it("read as none when the file is missing or isn't one", () => {
		expect(ledAreasAt(dir, "QEST-A", NOW)).toEqual([]);
		writeFileSync(join(dir, LED_AREAS_FILE), "{ not json");
		expect(ledAreasAt(dir, "QEST-A", NOW)).toEqual([]);
		writeFileSync(
			join(dir, LED_AREAS_FILE),
			JSON.stringify({
				v: 2,
				quests: {
					"QEST-A": [
						1,
						"x:y",
						{ subject: "x:z" },
						{ subject: "x:w", until: "later" },
						{ subject: "x:v", until: NOW + 1 },
					],
				},
			}),
		);
		expect(ledAreasAt(dir, "QEST-A", NOW)).toEqual(["x:y", "x:v"]);
	});

	// The council, 25 November: a pipe in the file's place would hold a
	// peer's refresh on a read that never ends.
	it("read as none, without waiting, where a pipe stands in the file's place", () => {
		execFileSync("mkfifo", [join(dir, LED_AREAS_FILE)]);
		expect(ledAreasAt(dir, "QEST-A", NOW)).toEqual([]);
	});
});
