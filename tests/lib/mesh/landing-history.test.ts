import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Landing } from "../../../lib/internal/session/landings.ts";
import {
	forgetLanding,
	type KeptLanding,
	keepLanding,
	kept,
	keyOf,
	LANDING_HISTORY_FILE,
	LANDINGS_KEPT_FOR_MS,
	landingKeeper,
	repoOf,
} from "../../../lib/mesh/landing-history.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "landings-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-07T23:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** A merge of the harness's, landed `ms` ago by session S1. */
function merge(number: number, ms = 60_000, session = "S1"): KeptLanding {
	return kept(
		{
			at: ago(ms),
			ref: `agentic-harness.pi#${number}`,
			what: `change ${number}`,
			url: `https://github.com/Jitsusama/agentic-harness.pi/pull/${number}`,
		},
		{ session, address: "85PKB2", quest: "QEST-1", machine: "optimus" },
	);
}

/** The history's landings by ref, newest first. */
function refs(): string[] {
	const file = JSON.parse(
		readFileSync(join(dir, LANDING_HISTORY_FILE), "utf8"),
	) as { v: number; landings: KeptLanding[] };
	expect(file.v).toBe(1);
	return file.landings.map((one) => one.ref);
}

describe("the landings kept a month", () => {
	it("keeps whose each is and where, newest first", async () => {
		await keepLanding(dir, merge(1043, 120_000), NOW);
		await keepLanding(dir, merge(1044), NOW);

		expect(refs()).toEqual([
			"agentic-harness.pi#1044",
			"agentic-harness.pi#1043",
		]);
		const file = JSON.parse(
			readFileSync(join(dir, LANDING_HISTORY_FILE), "utf8"),
		) as { landings: KeptLanding[] };
		expect(file.landings[0]).toEqual({
			key: "S1:agentic-harness.pi#1044",
			at: ago(60_000),
			ref: "agentic-harness.pi#1044",
			what: "change 1044",
			url: "https://github.com/Jitsusama/agentic-harness.pi/pull/1044",
			session: "S1",
			address: "85PKB2",
			quest: "QEST-1",
			repo: "Jitsusama/agentic-harness.pi",
			machine: "optimus",
		});
	});

	it("keeps a landing said again once, and another session's apart", async () => {
		await keepLanding(dir, merge(1044, 120_000), NOW);
		await keepLanding(dir, merge(1044), NOW);
		await keepLanding(dir, merge(1044, 30_000, "S2"), NOW);

		expect(refs()).toEqual([
			"agentic-harness.pi#1044",
			"agentic-harness.pi#1044",
		]);
	});

	it("lets go of what landed more than a month ago", async () => {
		await keepLanding(dir, merge(900, LANDINGS_KEPT_FOR_MS + 1), NOW);
		await keepLanding(dir, merge(1044), NOW);

		expect(refs()).toEqual(["agentic-harness.pi#1044"]);
	});

	it("takes back one landing by its key", async () => {
		await keepLanding(dir, merge(1043), NOW);
		await keepLanding(dir, merge(1044), NOW);
		await forgetLanding(dir, keyOf("S1", "agentic-harness.pi#1043"), NOW);

		expect(refs()).toEqual(["agentic-harness.pi#1044"]);
	});

	it("loses none when many sessions land at once", async () => {
		await Promise.all(
			[1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
				keepLanding(dir, merge(n, n * 1000, `S${n}`), NOW),
			),
		);

		expect(refs()).toHaveLength(8);
	});

	it("starts again from a file it can't read", async () => {
		writeFileSync(join(dir, LANDING_HISTORY_FILE), "{not json");
		await keepLanding(dir, merge(1044), NOW);

		expect(refs()).toEqual(["agentic-harness.pi#1044"]);
	});

	it("is written by the keeper a peer is handed, with this machine's name", async () => {
		const keeper = landingKeeper(dir, "optimus", () => NOW);
		const landing: Landing = {
			at: ago(1000),
			ref: "PLAN-20261030-QMUYBH#46",
			what: "item",
		};
		keeper.landed(landing, { session: "S1", repo: "agentic-harness.pi" });
		// The write runs in the background; the next takes its turn after it.
		await keepLanding(dir, merge(1044), NOW);

		const file = JSON.parse(
			readFileSync(join(dir, LANDING_HISTORY_FILE), "utf8"),
		) as { landings: KeptLanding[] };
		expect(
			file.landings.find((one) => one.ref.startsWith("PLAN")),
		).toMatchObject({
			machine: "optimus",
			repo: "agentic-harness.pi",
		});
	});
});

describe("the repository a landing names", () => {
	it("is a change's owner and name from its page, else its ref's repository", () => {
		expect(
			repoOf({
				at: "",
				ref: "agentic-harness.pi#1044",
				what: "",
				url: "https://github.com/Jitsusama/agentic-harness.pi/pull/1044",
			}),
		).toBe("Jitsusama/agentic-harness.pi");
		expect(repoOf({ at: "", ref: "core.nix#2234", what: "" })).toBe("core.nix");
	});

	it("is nothing for a plan item, which names a document", () => {
		expect(
			repoOf({ at: "", ref: "PLAN-20261030-QMUYBH#46", what: "" }),
		).toBeUndefined();
	});
});
