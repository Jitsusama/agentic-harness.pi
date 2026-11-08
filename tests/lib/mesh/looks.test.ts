import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { looksIn, pointAt, refusalOf } from "../../../lib/mesh/looks.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "looks-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pr = {
	kind: "pr" as const,
	target: "https://github.com/Jitsusama/agentic-harness.pi/pull/1070",
	title: "Quest carry",
	why: "It moves a quest's sessions between machines; worth a read before you use it.",
};
const who = { session: "S1", address: "85PKB2", quest: "QEST-1" };

// Joel, 8 November: "make sure they don't time out and don't get
// confused with other things".
describe("the person's look list", () => {
	it("keeps each look whole, with whose it is, what and why, newest first", () => {
		pointAt(dir, pr, who, new Date("2026-11-08T09:00:00Z"));
		const file = {
			kind: "file" as const,
			target: "/home/joel/src/core.nix/modules/pi/chime.nix",
			title: "The chime",
			why: "The ding you asked for; its pitch is set here.",
		};
		pointAt(dir, file, who, new Date("2026-11-08T09:05:00Z"));

		expect(looksIn(dir).map((look) => look.title)).toEqual([
			"The chime",
			"Quest carry",
		]);
		expect(looksIn(dir)[1]).toMatchObject({
			v: 1,
			session: "S1",
			address: "85PKB2",
			quest: "QEST-1",
			kind: "pr",
			target: pr.target,
			why: pr.why,
			state: "waiting",
		});
	});

	it("brings a look pointed at again to the top rather than adding it twice", () => {
		pointAt(dir, pr, who, new Date("2026-11-08T09:00:00Z"));
		pointAt(
			dir,
			{ ...pr, title: "Quest carry, merged" },
			who,
			new Date("2026-11-08T10:00:00Z"),
		);

		expect(looksIn(dir)).toHaveLength(1);
		expect(looksIn(dir)[0]).toMatchObject({
			title: "Quest carry, merged",
			at: "2026-11-08T10:00:00.000Z",
		});
		// Another session pointing at the same thing is a look of its own.
		pointAt(dir, pr, { session: "S2" }, new Date("2026-11-08T10:01:00Z"));
		expect(looksIn(dir)).toHaveLength(2);
	});

	it("keeps a look until the launcher takes it, whatever its age", () => {
		pointAt(dir, pr, who, new Date("2026-01-01T00:00:00Z"));

		expect(looksIn(dir)).toHaveLength(1);
	});

	it("reads past a file it can't make sense of, and an empty folder as none", () => {
		writeFileSync(join(dir, "torn.json"), "{not json");
		expect(looksIn(dir)).toEqual([]);
		expect(looksIn(join(dir, "none"))).toEqual([]);
	});

	it("refuses a look with no why, or one that can't open in its place", () => {
		expect(refusalOf({ ...pr, why: " " })).toMatch(
			/why the person should look/,
		);
		expect(refusalOf({ ...pr, title: "" })).toMatch(/what it is/);
		expect(
			refusalOf({ ...pr, target: "Jitsusama/agentic-harness.pi#1070" }),
		).toMatch(/by its URL/);
		expect(
			refusalOf({ ...pr, kind: "file", target: "modules/pi/chime.nix" }),
		).toMatch(/absolute path/);
		expect(refusalOf(pr)).toBeUndefined();
	});
});
