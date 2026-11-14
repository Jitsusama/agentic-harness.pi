import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { printed, sendersIn } from "../../scripts/void-owner.ts";

let scratch: string | null = null;

afterEach(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = null;
});

function message(folder: string, name: string, from: string, text: string): void {
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, name), JSON.stringify({ from, text }));
}

describe("the mesh senders a pull request is looked up in", () => {
	it("reads recent messages and the last two days' folders, and no older", () => {
		scratch = mkdtempSync(join(tmpdir(), "void-owner-"));
		const now = Date.parse("2026-11-14T16:00:00Z");
		message(scratch, "1-a.json", "2AF2DH", "opened shop/world#2430582");
		message(join(scratch, "2026-11-14"), "2-b.json", "2AF2DH", "pushed /pull/2430582");
		message(join(scratch, "2026-11-13"), "3-c.json", "5FWIUS", "saw shop/world#2430582");
		message(join(scratch, "2026-11-12"), "4-d.json", "OLD000", "shop/world#2430582");
		message(scratch, "5-e.json", "ZZZZZZ", "something else");
		writeFileSync(join(scratch, "6-f.json"), "{ half written");

		const senders = sendersIn(scratch, ["shop/world#2430582", "/pull/2430582"], now);

		expect(senders.toSorted()).toEqual(["2AF2DH", "2AF2DH", "5FWIUS"]);
	});
});

describe("what the void reads back", () => {
	it("gives a place a line, then what was tried", () => {
		const text = printed({
			candidates: [{ address: "EO6QV7", title: "SITE", how: "its README names the site once" }],
			tried: ["the page aquifer-part-deux.quick.shopify.io", "his words"],
		});

		expect(text).toBe(
			"EO6QV7\tSITE\tits README names the site once\n" +
				"tried: the page aquifer-part-deux.quick.shopify.io; his words\n",
		);
	});
});
