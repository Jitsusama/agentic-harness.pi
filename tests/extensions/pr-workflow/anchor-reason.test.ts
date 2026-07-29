/**
 * Why a finding will not anchor where it says it does.
 *
 * The old answer was a bare yes or no, so every warning blamed
 * the line numbers, including when the file itself was absent
 * from the diff. That sent people to edit a range that was
 * never the problem.
 */

import { describe, expect, it } from "vitest";
import { whyAnchorFails } from "../../../extensions/pr-workflow/post.js";
import type { DiffFile } from "../../../lib/review/index.js";
import { diffHunk, diffLine } from "./fixtures.js";

/** One file with lines 10 to 12 added, and nothing else. */
function files(): DiffFile[] {
	return [
		{
			newPath: "src/a.ts",
			oldPath: "src/a.ts",
			hunks: [
				diffHunk({
					newStart: 10,
					newCount: 3,
					lines: [
						diffLine({ newLine: 10 }),
						diffLine({ newLine: 11 }),
						diffLine({ newLine: 12 }),
					],
				}),
			],
		} as DiffFile,
	];
}

const at = (start: number, end: number, file = "src/a.ts") =>
	({ kind: "line", file, start, end, side: "new" }) as const;

describe("whyAnchorFails", () => {
	it("says nothing when the anchor lands", () => {
		expect(whyAnchorFails(at(10, 12), files())).toBeNull();
	});

	it("blames the file when the diff does not contain it at all", () => {
		// The distinction that motivated this: telling someone to
		// fix a line range when the file is the thing that is wrong
		// wastes their time.
		const reason = whyAnchorFails(at(10, 12, "src/absent.ts"), files());

		expect(reason).toMatch(/file/i);
		expect(reason).not.toMatch(/line range|those lines/i);
	});

	it("blames the lines when the file is there but the lines are not", () => {
		const reason = whyAnchorFails(at(90, 92), files());

		expect(reason).toMatch(/lines/i);
	});

	it("says a range crossing two hunks cannot be one remark", () => {
		const twoHunks: DiffFile[] = [
			{
				newPath: "src/a.ts",
				oldPath: "src/a.ts",
				hunks: [
					diffHunk({
						newStart: 10,
						newCount: 1,
						lines: [diffLine({ newLine: 10 })],
					}),
					diffHunk({
						newStart: 50,
						newCount: 1,
						lines: [diffLine({ newLine: 50 })],
					}),
				],
			} as DiffFile,
		];

		const reason = whyAnchorFails(at(10, 50), twoHunks);

		expect(reason).toMatch(/hunk/i);
	});

	it("refuses a location that is not about lines at all", () => {
		// A file-level or change-level finding was never going to be
		// an inline comment, and saying so keeps the caller honest.
		const reason = whyAnchorFails({ kind: "file", file: "src/a.ts" }, files());

		expect(reason).not.toBeNull();
	});

	it("agrees with the boolean the display sites still ask for", async () => {
		const { hasValidInlineAnchor } = await import(
			"../../../extensions/pr-workflow/post.js"
		);

		for (const location of [at(10, 12), at(90, 92), at(10, 12, "gone.ts")]) {
			expect(hasValidInlineAnchor(location, files())).toBe(
				whyAnchorFails(location, files()) === null,
			);
		}
	});
});
