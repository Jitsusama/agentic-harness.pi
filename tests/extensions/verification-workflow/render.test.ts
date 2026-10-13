import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	isVerificationReport,
	verificationLines,
} from "../../../extensions/verification-workflow/render.ts";

const theme = {
	fg: (colour: string, text: string) => `<${colour}>${text}</${colour}>`,
} as unknown as Theme;

const plain = (line: string) => line.replace(/<\/?[a-z]+>/g, "");

const report = {
	errors: [
		{
			path: "/work/a.ts",
			line: 3,
			character: 5,
			message: "Cannot find name 'x'",
		},
		{ path: "/work/a.ts", line: 9, character: 1, message: "Missing return" },
		{ path: "/elsewhere/b.ts", line: 1, character: 1, message: "Bad import" },
	],
};

describe("verification's line in the transcript", () => {
	it("says how many errors in how many files, on one narration line", () => {
		const lines = verificationLines(report, theme, 80, false, "/work");

		expect(lines.map(plain)).toEqual(["\u203b verify: 3 errors in 2 files"]);
	});

	it("colours the source, not the count", () => {
		const [line] = verificationLines(report, theme, 80, false, "/work");

		expect(line).toContain("<error>verify:</error>");
		expect(line).toContain("<dim>3 errors in 2 files</dim>");
	});

	it("lists every error when expanded, near paths shortened", () => {
		const lines = verificationLines(report, theme, 80, true, "/work");

		expect(lines.slice(1).map(plain)).toEqual([
			"  a.ts:3:5 Cannot find name 'x'",
			"  a.ts:9:1 Missing return",
			"  /elsewhere/b.ts:1:1 Bad import",
		]);
	});

	it("draws only what it wrote itself", () => {
		expect(isVerificationReport(report)).toBe(true);
		expect(isVerificationReport({ text: "something else" })).toBe(false);
		expect(isVerificationReport(undefined)).toBe(false);
	});
});
