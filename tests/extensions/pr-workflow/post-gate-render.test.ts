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

	it("surfaces the cross-PR finding count when stack-critic contributed", () => {
		const lines = renderPostGateContent(summary({ stackFindingCount: 3 }))(
			fakeTheme(),
			80,
		);
		expect(lines.join("\n")).toContain("3 cross-PR");
	});

	it("surfaces the skipped count when findings were dropped", () => {
		const lines = renderPostGateContent(summary({ skippedCount: 2 }))(
			fakeTheme(),
			80,
		);
		expect(lines.join("\n")).toMatch(/2 skipped/);
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
});
