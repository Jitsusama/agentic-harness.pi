/**
 * The harness's files in a carry an orchestrator orders, as mycelium
 * reads them: the refusal beside the done file, and the steer that tells
 * an arriving session who carried it and why.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
});
