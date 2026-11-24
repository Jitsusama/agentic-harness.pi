import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type NeedsDeps,
	needsCommand,
} from "../../../extensions/mesh-workflow/needs-command.ts";
import {
	forAModel,
	looksRead,
	needsRead,
	waitingRecords,
	whatWaitsText,
} from "../../../extensions/mesh-workflow/tools/person.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import { sessionAddress } from "../../../lib/mesh/address.ts";
import { looksIn, pointAt } from "../../../lib/mesh/looks/looks.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "needs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-24T14:30:00Z");

const listing = [
	JSON.stringify({
		name: "A1B2C3",
		title: "Disk sweep",
		asks: "May I delete the old logs?",
		since: "2026-11-24T14:00:00Z",
		machine: "equilibrius",
	}),
].join("\n");

/** What he said lately, as `mycelium said` lists it, oldest first. */
const saidListing = [
	JSON.stringify({
		address: "D4E5F6",
		machine: "optimus",
		at: "2026-11-24T14:10:00.000Z",
		taken_up: "2026-11-24T14:10:01.000Z",
		text: "Carry on with the sweep",
		kind: "said",
	}),
].join("\n");

/** What a run of /needs did: what it ran, and what it told him. */
interface Ran {
	readonly ran: string[][];
	readonly told: string[];
	readonly asked: string[][];
}

/**
 * /needs run against fakes: the node lists `cells` and what he `said`,
 * every link opens, and he picks each of `picks` in turn, by words of
 * its label.
 */
async function run(
	picks: readonly string[],
	cells = listing,
	refusal?: number,
	said = "",
	failing: { said?: boolean; open?: boolean; looks?: string } = {},
): Promise<Ran> {
	const ran: string[][] = [];
	const told: string[] = [];
	const asked: string[][] = [];
	const queue = [...picks];
	const deps: NeedsDeps = {
		exec: async (command, args) => {
			ran.push([command, ...args]);
			if (command === "mycelium" && failing.said && args[0] === "said") {
				return { stdout: "", stderr: "no said", code: 3, killed: false };
			}
			if (command === "mycelium") {
				return refusal === undefined
					? {
							stdout: args[0] === "said" ? said : cells,
							stderr: "",
							code: 0,
							killed: false,
						}
					: { stdout: "", stderr: "no node", code: refusal, killed: false };
			}
			return failing.open
				? { stdout: "", stderr: "no opener", code: 4, killed: false }
				: { stdout: "", stderr: "", code: 0, killed: false };
		},
		looks: failing.looks ?? dir,
		ui: {
			select: async (_title: string, options: string[]) => {
				asked.push(options);
				const pick = queue.shift();
				return pick === undefined
					? undefined
					: options.find((option) => option.includes(pick));
			},
			notify: (message: string) => {
				told.push(message);
			},
		},
		now: () => NOW,
		machine: "optimus",
	};
	await needsCommand(deps);
	return { ran, told, asked };
}

/** A look from cell 85PKB2, asking nothing back. */
function look(
	kind: "page" | "terminal" | "diff" = "page",
	target = kind === "terminal" ? "S9" : "https://example.com/plan",
) {
	return pointAt(
		dir,
		{
			kind,
			target,
			title: "The plan",
			why: "Worth a read.",
			ask: "Nothing, just to see.",
		},
		{ session: "S9", address: "85PKB2", quest: "QEST-1" },
		new Date("2026-11-24T14:20:00Z"),
	);
}

// Joel, 24 November: "any interface i'm in should be directly engagable
// to a meaningful level".
describe("/needs", () => {
	it("lists every cell needing him, how long it has waited, then his looks", async () => {
		look();

		const { asked, ran } = await run([]);

		expect(ran[0]).toEqual([
			"mycelium",
			"cells",
			"--standing",
			"needs-you",
			"-o",
			"json",
		]);
		expect(asked[0]).toEqual([
			"1. A1B2C3 on equilibrius, waiting 30 min: May I delete the old logs? (Disk sweep)",
			"2. Look: The plan from 85PKB2 (page): Worth a read.",
		]);
	});

	it("goes to the picked cell on its own machine, where he answers it", async () => {
		const { ran } = await run(["A1B2C3"]);

		expect(ran.at(-1)).toEqual([
			"xdg-open",
			"mycelium:cell/A1B2C3@equilibrius/go",
		]);
	});

	it("opens a picked look and marks it opened", async () => {
		const pointed = look();

		const { ran } = await run(["Look:", "Open it"]);

		expect(ran.at(-1)).toEqual(["xdg-open", "https://example.com/plan"]);
		expect(looksIn(dir).find((one) => one.id === pointed.id)?.state).toBe(
			"opened",
		);
	});

	it("opens a terminal look by going to the cell that pointed", async () => {
		look("terminal");

		const { ran } = await run(["Look:", "Open it"]);

		// The cell is the pointing session's own address, not the one it signs with.
		expect(ran.at(-1)).toEqual([
			"xdg-open",
			`mycelium:cell/${sessionAddress("S9")}@optimus/go`,
		]);
	});

	it("clears a picked look off his list, as the launcher does", async () => {
		const pointed = look();

		const { told } = await run(["Look:", "Clear it"]);

		expect(looksIn(dir).find((one) => one.id === pointed.id)).toMatchObject({
			state: "cleared",
			how: "cleared by you",
		});
		expect(told).toEqual(["Cleared: it's off your look list."]);
	});

	it("leaves a look as it was when he leaves it, or picks nothing", async () => {
		look();
		const before = looksIn(dir);

		const left = await run(["Look:", "Leave it"]);
		const none = await run([]);

		expect(looksIn(dir)).toEqual(before);
		expect(left.ran.filter(([command]) => command === "xdg-open")).toEqual([]);
		expect(none.ran.filter(([command]) => command === "xdg-open")).toEqual([]);
	});

	it("says when the cells can't be read, and still offers his looks", async () => {
		look();

		const { told, asked } = await run([], listing, 2);

		expect(told[0]).toContain("The cells couldn't be read");
		expect(told[0]).toContain("no node");
		expect(asked[0]).toHaveLength(1);
	});

	it("shows how what he said stands, and goes to the cell he said it to", async () => {
		const { asked, ran } = await run(["You said"], "", undefined, saidListing);

		expect(asked[0]).toEqual([
			"1. You said to D4E5F6 on optimus, 20 min ago: Carry on with the sweep (working)",
		]);
		expect(ran.at(-1)).toEqual(["xdg-open", "mycelium:cell/D4E5F6@optimus/go"]);
	});

	it("never says nothing waits when what he said couldn't be read", async () => {
		const { told, asked } = await run([], "", undefined, "", { said: true });

		expect(told).toEqual([
			"What you said couldn't be read: mycelium said ended 3: no said",
		]);
		expect(asked).toEqual([]);
	});

	it("says when nothing could be read at all, never that nothing waits", async () => {
		const { told } = await run([], listing, 2, "", {
			looks: join(dir, "not-a-folder", "\u0000"),
		});

		expect(told.join("\n")).toContain("The cells couldn't be read");
		expect(told.join("\n")).toContain("Your look list couldn't be read");
		expect(told.join("\n")).toContain("What you said couldn't be read");
		expect(told).not.toContain("Nothing waits on you.");
	});

	it("reads a listing it can't read as a failure, not as nothing", async () => {
		const { told } = await run([], '{"cells":[]}\n');

		expect(told.join("\n")).toContain(
			"The cells couldn't be read: mycelium cells answered nothing this harness reads",
		);
		expect(told).not.toContain("Nothing waits on you.");
	});

	it("leaves a look waiting when it doesn't open", async () => {
		const pointed = look();

		const { told } = await run(["Look:", "Open it"], listing, undefined, "", {
			open: true,
		});

		expect(told.join("\n")).toContain("It didn't open (4): no opener");
		expect(looksIn(dir).find((one) => one.id === pointed.id)?.state).toBe(
			"waiting",
		);
	});

	it("goes to the cell that pointed without marking the look", async () => {
		const pointed = look();

		const { ran, asked } = await run(["Look:", "Go to"]);

		expect(asked[1]?.find((act) => act.startsWith("Go to"))).toBeDefined();
		expect(ran.at(-1)).toEqual([
			"xdg-open",
			`mycelium:cell/${sessionAddress("S9")}@optimus/go`,
		]);
		expect(looksIn(dir).find((one) => one.id === pointed.id)?.state).toBe(
			"waiting",
		);
	});

	it("refuses a diff look that isn't a web address, opening nothing", async () => {
		look("diff", "--help");

		const { ran, told } = await run(["Look:", "Open it"]);

		expect(ran.filter(([command]) => command === "xdg-open")).toEqual([]);
		expect(told.join("\n")).toContain("opens only by a web address");
	});

	it("says nothing waits when nothing does, and asks nothing", async () => {
		const { told, asked } = await run([], "");

		expect(told).toEqual(["Nothing waits on you."]);
		expect(asked).toEqual([]);
	});
});

describe("what the model reads of it", () => {
	it("lists both, and says only the person acts on them", () => {
		const text = whatWaitsText(
			{
				needs: {
					ok: true,
					needs: [
						{
							name: "A1B2C3",
							title: "",
							asks: "a yes",
							since: "2026-11-24T14:00:00Z",
						},
					],
				},
				looks: { ok: true, looks: [look()] },
				said: {
					ok: true,
					said: [
						{
							address: "D4E5F6",
							at: "2026-11-24T14:25:00Z",
							text: "Ship it",
							standing: "answered",
						},
					],
				},
			},
			NOW,
		);

		expect(text).toContain("- A1B2C3, waiting 30 min: a yes");
		expect(text).toContain("- to D4E5F6, 5 min ago: Ship it (answered)");
		expect(text).toMatch(
			/- \[[^\]]+\] The plan from 85PKB2 \(page\): Worth a read\./,
		);
	});

	it("says why the cells couldn't be read, rather than that none need him", () => {
		const text = whatWaitsText(
			{
				needs: { ok: false, reason: "mycelium couldn't be run" },
				looks: { ok: false, reason: "it is gone" },
				said: { ok: false, reason: "mycelium couldn't be run" },
			},
			NOW,
		);

		expect(text).toContain(
			"The cells couldn't be read: mycelium couldn't be run.",
		);
		expect(text).not.toContain("No cell needs");
		expect(text).toContain("What the person said couldn't be read");
		expect(text).toContain("The look list couldn't be read: it is gone.");
		expect(text).not.toContain("Nothing is on the person's look list");
	});

	it("shows a model only the start of each thing he said, and tags each record", () => {
		const long = `${"x".repeat(79)}\u{1F600}and more after it`;
		const waits = forAModel({
			needs: { ok: true, needs: [] },
			looks: { ok: true, looks: [look()] },
			said: {
				ok: true,
				said: [
					{
						address: "D4E5F6",
						at: "2026-11-24T14:25:00Z",
						text: long,
						standing: "working",
					},
				],
			},
		});

		expect(waits.said.ok && waits.said.said[0]?.text).toBe(
			`${"x".repeat(79)}\u{1F600}...`,
		);
		expect(
			waitingRecords(waits).map((one) =>
				isRecord(one) ? one.type : undefined,
			),
		).toEqual(["look", "said"]);
	});
});

describe("reading what waits", () => {
	it("reads a run its clock stopped as a failure, whatever its code", async () => {
		const read = await needsRead(async () => ({
			stdout: listing.slice(0, 10),
			stderr: "",
			code: 0,
			killed: true,
		}));

		expect(read.ok).toBe(false);
		expect(read.ok ? "" : read.reason).toContain(
			"was stopped before it answered",
		);
	});

	it("reads a look list not yet made as empty, and none kept as unread", async () => {
		expect(await looksRead(join(dir, "none-yet"))).toEqual({
			ok: true,
			looks: [],
		});
		expect(await looksRead(undefined)).toMatchObject({ ok: false });
	});
});
