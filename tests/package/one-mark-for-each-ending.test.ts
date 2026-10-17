/**
 * Everything that ends says so with the same three marks.
 *
 * A gate's record, a Slack or Google send and a spawned agent each end
 * done, cancelled or failed. The gates and the Slack and Google tools
 * wrote a ballot x for a cancel, a refusal and a failure alike, while
 * review, the footer and the spawned-agent set wrote a multiplication
 * cross for a failure and a minus for a cancel. One session showed two
 * crosses for failing, and a cancel that read as a failure.
 *
 * So the endings are spelled once, and the ballot crosses are spelled
 * nowhere: not in a source, where they reach the screen, and not in a
 * skill, where they teach a model to look for a mark nothing draws.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_GLYPH, OUTCOME_GLYPH } from "../../lib/ui/index.ts";

/** The ballot x and its heavy twin, which no surface may draw. */
const BALLOT_CROSSES = /[\u2717\u2718]|\\u271[78]/;

/** Every tracked source and skill, by its path. */
function shipped(): string[] {
	const listing = execFileSync(
		"git",
		[
			"-C",
			process.cwd(),
			"ls-files",
			"-z",
			"extensions/**/*.ts",
			"lib/**/*.ts",
			"skills/**/*.md",
		],
		{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
	return listing.split("\0").filter((path) => path !== "");
}

/** The gates whose record says how they were answered. */
const RECORDS = [
	"lib/ui/prompt-single.ts",
	"lib/ui/prompt-tabbed.ts",
	"lib/ui/prompt-toggle-list.ts",
];

describe("one mark for each ending", () => {
	it("reads the package it means to check", () => {
		// A gate reading nothing passes. This is the check that it read.
		const paths = shipped();

		expect(paths.length).toBeGreaterThan(200);
		for (const path of RECORDS) expect(paths).toContain(path);
	});

	it("gives each ending a mark of its own", () => {
		const marks = Object.values(OUTCOME_GLYPH);

		expect(new Set(marks).size).toBe(marks.length);
	});

	it("ends spawned work with the same three marks", () => {
		expect(AGENT_GLYPH.done).toBe(OUTCOME_GLYPH.done);
		expect(AGENT_GLYPH.cancelled).toBe(OUTCOME_GLYPH.cancelled);
		expect(AGENT_GLYPH.failed).toBe(OUTCOME_GLYPH.failed);
	});

	it("records each gate's answer from the one set", () => {
		// Spelled by hand, as a character or an escape, a record keeps its
		// mark when the set changes; naming the set elsewhere in the file
		// says nothing about the record that doesn't.
		const spelled = new RegExp(
			Object.values(OUTCOME_GLYPH)
				.flatMap((mark) => [
					mark,
					`\\\\u${mark.codePointAt(0)?.toString(16).padStart(4, "0")}`,
				])
				.join("|"),
			"i",
		);
		for (const path of RECORDS) {
			const source = readFileSync(path, "utf8");
			const byHand = source
				.split("\n")
				.filter((line) => spelled.test(line))
				.map((line) => line.trim());

			const named = source.includes("OUTCOME_GLYPH");

			expect({ path, named, byHand }).toEqual({
				path,
				named: true,
				byHand: [],
			});
		}
	});

	it("draws no second cross anywhere", () => {
		const crossed = shipped().flatMap((path) =>
			readFileSync(path, "utf8")
				.split("\n")
				.flatMap((line, index) =>
					BALLOT_CROSSES.test(line)
						? [`${path}:${index + 1}: ${line.trim()}`]
						: [],
				),
		);

		expect(crossed).toEqual([]);
	});
});
