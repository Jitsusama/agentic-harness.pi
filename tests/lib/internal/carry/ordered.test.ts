/**
 * The harness's files in a carry an orchestrator orders, as mycelium
 * reads them: the refusal beside the done file, and the steer that tells
 * an arriving session who carried it and why.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	carriedBy,
	refusedFileOf,
	tellCarried,
	writeRefused,
} from "../../../../lib/internal/carry/ordered.ts";
import { sessionAddress } from "../../../../lib/mesh/address.ts";
import { inboxOf, takeSteers } from "../../../../lib/mesh/steer.ts";
import { folder, removeAll } from "./support/machines.ts";

const made: string[] = [];
afterEach(() => removeAll(made));

const SESSION = "01a1e0b5-43d1-7577-8e53-a727363da9a8";

describe("refusing an ordered carry", () => {
	it("writes the session, why and when beside where its done file would go, and nothing else", () => {
		const handover = join(folder(made, "scratch"), "handover", "optimus");

		const file = writeRefused(handover, {
			session: SESSION,
			why: "a work job is out (j3: push in the held tree)",
			at: new Date("2026-11-15T15:30:00.000Z"),
		});

		expect(file).toBe(refusedFileOf(handover, SESSION));
		expect(file).toBe(join(handover, `${SESSION}.refused.json`));
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			session: SESSION,
			why: "a work job is out (j3: push in the held tree)",
			at: "2026-11-15T15:30:00.000Z",
		});
		expect(
			readdirSync(handover).filter((name) => !name.startsWith(".")),
			"written whole, leaving nothing beside but the folder it was written in",
		).toEqual([`${SESSION}.refused.json`]);
	});

	it("leaves a newer refusal where it is, so one landing late never hides a later carry's", () => {
		const handover = join(folder(made, "scratch"), "handover", "optimus");
		const later = {
			session: SESSION,
			why: "a work job is out",
			at: new Date("2026-11-15T15:31:00.000Z"),
		};
		const now = Date.parse("2026-11-15T15:35:00.000Z");
		writeRefused(handover, later, now);

		const file = writeRefused(
			handover,
			{
				session: SESSION,
				why: "its run didn't end in time",
				at: new Date("2026-11-15T15:30:00.000Z"),
			},
			now,
		);

		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			...later,
			at: "2026-11-15T15:31:00.000Z",
		});

		writeRefused(
			handover,
			{
				session: SESSION,
				why: "it holds a lease",
				at: new Date("2026-11-15T15:32:00.000Z"),
			},
			now,
		);
		expect(
			JSON.parse(readFileSync(file, "utf8")).why,
			"a newer one replaces it",
		).toBe("it holds a lease");
	});

	// Its own stamp is the end of its steer's millisecond, so one written
	// a moment ago may be just ahead of now, and must still stand.
	it("leaves a newer refusal just ahead of now where it is, and replaces one further ahead", () => {
		const handover = join(folder(made, "scratch"), "handover", "optimus");
		const now = Date.parse("2026-11-19T14:00:00.000Z");
		const older = { session: SESSION, why: "its run didn't end in time" };
		const file = writeRefused(
			handover,
			{ session: SESSION, why: "a work job is out", at: new Date(now + 1) },
			now,
		);
		writeRefused(handover, { ...older, at: new Date(now - 1_000) }, now);
		expect(
			JSON.parse(readFileSync(file, "utf8")).why,
			"1 ms ahead stands",
		).toBe("a work job is out");

		writeRefused(
			handover,
			{ session: SESSION, why: "a work job is out", at: new Date(now + 1_001) },
			now,
		);
		writeRefused(handover, { ...older, at: new Date(now - 1_000) }, now);
		expect(
			JSON.parse(readFileSync(file, "utf8")).why,
			"over a second ahead is replaced",
		).toBe("its run didn't end in time");
	});

	// A clock stepped back, or a steer named ahead, could leave one dated
	// ahead, which would otherwise stand over every refusal after it.
	it("replaces a refusal dated ahead of now, so none stands over every later one", () => {
		const handover = join(folder(made, "scratch"), "handover", "optimus");
		const now = Date.parse("2026-11-19T14:00:00.000Z");
		writeRefused(
			handover,
			{
				session: SESSION,
				why: "a work job is out",
				at: new Date("2286-11-20T17:46:40.000Z"),
			},
			now,
		);

		const file = writeRefused(
			handover,
			{
				session: SESSION,
				why: "it holds a lease",
				at: new Date(now),
			},
			now,
		);

		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			session: SESSION,
			why: "it holds a lease",
			at: "2026-11-19T14:00:00.000Z",
		});
	});
});

describe("telling an arriving session who carried it", () => {
	it("steers it as the machine's pi-carry, never as the person, naming who and why", () => {
		const root = folder(made, "steer");

		tellCarried(root, {
			session: SESSION,
			from: "optimus",
			by: "WCJQSG",
			why: "its camera work needs the Mac",
		});

		const [steer, ...more] = takeSteers(
			inboxOf(root, sessionAddress(SESSION)),
			"1",
		).steers;
		expect(more).toEqual([]);
		expect(steer).toMatchObject({ from: "machine", by: "pi-carry" });
		expect(steer).not.toHaveProperty("act");
		expect(steer?.text).toContain(
			"carried here from optimus by WCJQSG, for its camera work needs the Mac",
		);
		expect(steer?.text).toContain("The person didn't carry it");
	});

	// ISXEG8's condition 3: a carry the node chose is said as the node's.
	it("says a node's own carry as that node's, never an orchestrator's", () => {
		const root = folder(made, "steer");

		tellCarried(root, {
			session: SESSION,
			from: "optimus",
			by: "node@optimus",
			why: "optimus has stalled for ten minutes and penelope has room",
		});

		const [steer] = takeSteers(
			inboxOf(root, sessionAddress(SESSION)),
			"1",
		).steers;
		expect(steer).toMatchObject({ from: "machine", by: "pi-carry" });
		expect(steer?.text).toContain(
			"carried here from optimus by node@optimus, for optimus has stalled",
		);
		expect(steer?.text).toContain(
			"The person didn't carry it, and no orchestrator ordered it: the mycelium node on optimus chose to, on its own.",
		);
		// The reason is the node's own, said once; nothing more is claimed.
		expect(steer?.text).not.toContain("checked that it may");
		expect(steer?.text).not.toContain("the orchestrator above its quest");
	});
});

describe("who an arrival says carried it", () => {
	it("an orchestrator's address in capitals, or the node of the machine it left as written", () => {
		expect(carriedBy("wcjqsg", "optimus")).toBe("WCJQSG");
		expect(carriedBy("node@optimus", "optimus")).toBe("node@optimus");
		expect(carriedBy("node@Optimus-2", "Optimus-2")).toBe("node@Optimus-2");
	});

	it("no other node, no other letters, and nothing that isn't an address", () => {
		for (const [said, by] of [
			["another machine's node", "node@penelope"],
			["the node in other letters", "NODE@optimus"],
			["its machine in other letters", "node@Optimus"],
			["the person", "person"],
			["the machine", "MACHINE"],
			["a node of no machine", "node@"],
			["no address", "../x"],
			["too long an address", "WCJQSGWCJ"],
		] as const) {
			expect(carriedBy(by, "optimus"), said).toBeUndefined();
		}
	});
});
