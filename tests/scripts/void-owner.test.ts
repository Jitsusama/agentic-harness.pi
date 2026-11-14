import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filesOf, printed, sendersIn } from "../../scripts/void-owner.ts";

let scratch: string | null = null;

afterEach(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = null;
});

function message(
	folder: string,
	name: string,
	from: string,
	text: string,
): void {
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, name), JSON.stringify({ from, text }));
}

describe("the mesh senders a pull request is looked up in", () => {
	it("reads recent messages and the last two days' folders, and no older", () => {
		scratch = mkdtempSync(join(tmpdir(), "void-owner-"));
		const now = Date.parse("2026-11-14T16:00:00Z");
		message(scratch, "1-a.json", "2AF2DH", "opened shop/world#2430582");
		message(
			join(scratch, "2026-11-14"),
			"2-b.json",
			"2AF2DH",
			"pushed /pull/2430582",
		);
		message(
			join(scratch, "2026-11-13"),
			"3-c.json",
			"5FWIUS",
			"saw shop/world#2430582",
		);
		message(
			join(scratch, "2026-11-12"),
			"4-d.json",
			"OLD000",
			"shop/world#2430582",
		);
		message(scratch, "5-e.json", "ZZZZZZ", "something else");
		writeFileSync(join(scratch, "6-f.json"), "{ half written");

		const senders = sendersIn(
			scratch,
			["shop/world#2430582", "/pull/2430582"],
			now,
		);

		expect([...senders].sort()).toEqual(["2AF2DH", "2AF2DH", "5FWIUS"]);
	});
});

describe("what the void reads back", () => {
	it("gives a place a line, then what was tried", () => {
		const text = printed({
			candidates: [
				{
					address: "EO6QV7",
					title: "SITE",
					how: "its README names the site once",
				},
			],
			tried: ["the page aquifer-part-deux.quick.shopify.io", "his words"],
		});

		expect(text).toBe(
			"EO6QV7\tSITE\tits README names the site once\n" +
				"tried: the page aquifer-part-deux.quick.shopify.io; his words\n",
		);
	});
});

describe("the files a pull request touches", () => {
	const listing = JSON.stringify([
		{ filename: "areas/incubating/aquifer/a.rs" },
		{ filename: "areas/incubating/aquifer/b.rs" },
	]);

	it("asks Delta for a Delta pull request's files", () => {
		const asked: string[][] = [];
		const files = filesOf(
			{ host: "delta.shopify.io", repo: "shop/world", number: "2431000" },
			(command, args) => {
				asked.push([command, ...args]);
				return listing;
			},
		);

		expect(files).toEqual([
			"areas/incubating/aquifer/a.rs",
			"areas/incubating/aquifer/b.rs",
		]);
		expect(asked).toEqual([
			[
				"dt",
				"api",
				"--host",
				"https://delta.shopify.io",
				"-R",
				"shop/world",
				"/api/v3/repos/shop/world/pulls/2431000/files?per_page=100",
			],
		]);
	});

	it("asks GitHub for a GitHub pull request's files", () => {
		const asked: string[][] = [];
		filesOf(
			{ host: "github.com", repo: "a/b", number: "7" },
			(command, args) => {
				asked.push([command, ...args]);
				return listing;
			},
		);

		expect(asked).toEqual([
			["gh", "api", "repos/a/b/pulls/7/files?per_page=100"],
		]);
	});

	it("knows nothing of a host it can't ask, or when asking fails", () => {
		const failing = (): string => {
			throw new Error("not signed in");
		};

		expect(
			filesOf({ host: "example.com", repo: "a/b", number: "7" }, () => listing),
		).toBeUndefined();
		expect(
			filesOf({ host: "github.com", repo: "a/b", number: "7" }, failing),
		).toBeUndefined();
		expect(
			filesOf({ host: "github.com", repo: "a/b", number: "7" }, () => "{}"),
		).toBeUndefined();
	});
});
