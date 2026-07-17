import { describe, expect, it } from "vitest";
import {
	type PostGateSummary,
	renderPostGateContent,
} from "../../../extensions/pr-workflow/post-gate-render.js";
import { fakeTheme } from "../../lib/ui/fake-theme.js";

function summary(overrides: Partial<PostGateSummary> = {}): PostGateSummary {
	return {
		event: "COMMENT",
		body: "Council review: 2 finding(s) posted.",
		inlineCount: 2,
		bodyFindingCount: 1,
		stackFindingCount: 0,
		skippedCount: 0,
		findings: [
			{
				id: 14,
				label: "issue",
				subject: "Crash on null",
				location: "cache.ts:12-14",
			},
			{
				id: 15,
				label: "nit",
				subject: "Variable shadowing",
				location: "config.ts",
			},
		],
		skipped: [],
		...overrides,
	};
}

describe("renderPostGateContent", () => {
	it("shows the event and a count summary line", () => {
		const lines = renderPostGateContent(summary())(fakeTheme(), 80);
		const text = lines.join("\n");
		expect(text).toContain("COMMENT");
		expect(text).toContain("2 inline");
		expect(text).toContain("1 in body");
	});

	it("shows the head-drift warning when one is present", () => {
		const lines = renderPostGateContent(
			summary({
				headDriftWarning:
					"The PR head advanced from aaaaaaa to bbbbbbb since the diff was loaded.",
			}),
		)(fakeTheme(), 80);
		const text = lines.join("\n");
		expect(text).toMatch(/head/i);
		expect(text).toContain("aaaaaaa");
	});

	it("omits the head-drift line when there is no drift", () => {
		const lines = renderPostGateContent(summary())(fakeTheme(), 80);
		expect(lines.join("\n")).not.toMatch(/head advanced/i);
	});

	it("includes the review body verbatim", () => {
		const lines = renderPostGateContent(
			summary({ body: "First line.\nSecond line." }),
		)(fakeTheme(), 80);
		const text = lines.join("\n");
		expect(text).toContain("First line.");
		expect(text).toContain("Second line.");
	});

	it("lists every finding subject so the user can spot bad ones before posting", () => {
		const lines = renderPostGateContent(summary())(fakeTheme(), 80);
		const text = lines.join("\n");
		expect(text).toContain("[14]");
		expect(text).toContain("Crash on null");
		expect(text).toContain("cache.ts:12-14");
		expect(text).toContain("[15]");
		expect(text).toContain("Variable shadowing");
	});

	it("surfaces the cross-PR finding count when cross-PR contributed", () => {
		const lines = renderPostGateContent(summary({ stackFindingCount: 3 }))(
			fakeTheme(),
			80,
		);
		expect(lines.join("\n")).toContain("3 cross-PR");
	});

	it("surfaces skipped findings with reasons", () => {
		const lines = renderPostGateContent(
			summary({
				skippedCount: 2,
				skipped: [
					{ displayId: "14", reason: "dismissed by user" },
					{ displayId: "S18", reason: "stack: queued for fix" },
				],
			}),
		)(fakeTheme(), 80);
		const text = lines.join("\n");
		expect(text).toMatch(/2 skipped/);
		expect(text).toContain("Skipped:");
		expect(text).toContain("[14] dismissed by user");
		expect(text).toContain("[S18] stack: queued for fix");
	});

	it("hides the cross-PR and skipped lines when zero", () => {
		const lines = renderPostGateContent(summary())(fakeTheme(), 80);
		const text = lines.join("\n");
		expect(text).not.toMatch(/cross-PR/);
		expect(text).not.toMatch(/skipped/);
	});

	it("renders APPROVE and REQUEST_CHANGES events distinctly", () => {
		const approve = renderPostGateContent(summary({ event: "APPROVE" }))(
			fakeTheme(),
			80,
		);
		const reject = renderPostGateContent(summary({ event: "REQUEST_CHANGES" }))(
			fakeTheme(),
			80,
		);
		expect(approve.join("\n")).toContain("APPROVE");
		expect(reject.join("\n")).toContain("REQUEST_CHANGES");
	});

	it("wraps long body and finding lines to the content width", () => {
		const lines = renderPostGateContent(
			summary({
				body: "This is a very long review body line that should wrap before it reaches the edge of the confirmation panel.",
				findings: [
					{
						id: 14,
						label: "issue",
						subject:
							"This finding subject is intentionally long enough to require wrapping in the post gate",
						location: "cache.ts:12-14",
					},
				],
			}),
		)(fakeTheme(), 40);

		expect(
			lines.every((line) => line.replace(/<[^>]+>/g, "").length <= 40),
		).toBe(true);
		expect(lines.some((line) => line.includes("This is a very long"))).toBe(
			true,
		);
		expect(lines.some((line) => line.includes("confirmation panel"))).toBe(
			true,
		);
		expect(lines.some((line) => line.includes("[14] [issue]"))).toBe(true);
		expect(
			lines.some((line) => line.includes("wrapping in the post gate")),
		).toBe(true);
	});
});
