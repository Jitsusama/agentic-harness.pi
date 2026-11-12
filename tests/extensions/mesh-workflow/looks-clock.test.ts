import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	expiredText,
	keepLooks,
} from "../../../extensions/mesh-workflow/looks-clock.ts";
import { looksIn, pointAt, SHOWING_LASTS_MS } from "../../../lib/mesh/looks.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "looks-clock-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const shows = {
	kind: "pr" as const,
	target: "https://github.com/owner/repo/pull/7",
	title: "The narrow bar",
	why: "The bar keeps the model at narrow widths now.",
	ask: "Nothing, just to see.",
};
const t0 = new Date("2026-11-12T09:00:00Z");
const aDayOn = new Date(t0.getTime() + SHOWING_LASTS_MS);

describe("the looks clock", () => {
	it("expires this quest's looks past their time, whichever of its sessions pointed", () => {
		pointAt(dir, shows, { session: "S1", quest: "Q1" }, t0);
		pointAt(dir, shows, { session: "S2", quest: "Q2" }, t0);

		const expired = keepLooks(dir, { session: "S9", quest: "Q1" }, aDayOn);

		expect(
			expired.map((look) => look.quest),
			"Q1's look",
		).toEqual(["Q1"]);
		expect(
			looksIn(dir)
				.map((look) => `${look.quest} ${look.state}`)
				.sort(),
			"Q2's look waits for Q2",
		).toEqual(["Q1 expired", "Q2 waiting"]);
	});

	it("lets anyone's opened look that asked nothing back leave", () => {
		const look = pointAt(dir, shows, { session: "S2", quest: "Q2" }, t0);
		const file = join(dir, `${look.id}.json`);
		const kept: Record<string, unknown> = JSON.parse(
			readFileSync(file, "utf8"),
		);
		writeFileSync(file, JSON.stringify({ ...kept, state: "opened" }));

		keepLooks(dir, { session: "S1", quest: "Q1" }, t0);

		expect(looksIn(dir)[0]).toMatchObject({ state: "resolved", how: "seen" });
	});

	it("keeps nothing where there is no list yet", () => {
		expect(keepLooks(join(dir, "none"), { session: "S1" }, t0)).toEqual([]);
	});

	it("tells the agent which of its looks went, by title", () => {
		const look = pointAt(dir, shows, { session: "S1" }, t0);

		expect(expiredText([]), "nothing to say").toBeUndefined();
		expect(expiredText([look])).toContain('"The narrow bar"');
	});
});
