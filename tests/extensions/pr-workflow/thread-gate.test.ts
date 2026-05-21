import { describe, expect, it } from "vitest";
import {
	renderReplyGateContent,
	renderResolveGateContent,
} from "../../../extensions/pr-workflow/thread-gate-render.js";
import type { ReviewThread } from "../../../extensions/pr-workflow/threads.js";
import { fakeTheme } from "../../lib/ui/fake-theme.js";

function visibleLength(line: string): number {
	return line.replace(/<[^>]+>/g, "").length;
}

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
	return {
		id: "T1",
		kind: "review-thread",
		isResolved: false,
		isOutdated: false,
		path: "src/foo.ts",
		line: 10,
		comments: [
			{
				id: "C1",
				author: "octocat",
				body: "Could this be simpler?",
				createdAt: "2024-01-01T00:00:00Z",
				url: "https://example.com/c1",
			},
		],
		...overrides,
	};
}

describe("renderReplyGateContent", () => {
	it("renders thread location, existing comment and proposed reply", () => {
		const lines = renderReplyGateContent(thread(), "Fixed in a1b2c3d.")(
			fakeTheme(),
			80,
		);
		const text = lines.join("\n");
		expect(text).toContain("src/foo.ts:10");
		expect(text).toContain("@octocat");
		expect(text).toContain("Could this be simpler?");
		expect(text).toContain("Proposed reply");
		expect(text).toContain("Fixed in a1b2c3d.");
	});

	it("labels PR-level threads when path is null", () => {
		const lines = renderReplyGateContent(
			thread({ path: null, line: null }),
			"ack",
		)(fakeTheme(), 80);
		expect(lines.join("\n")).toContain("(PR-level)");
	});

	it("labels review-level comments distinctly", () => {
		const lines = renderReplyGateContent(
			thread({ kind: "review-level", path: null, line: null }),
			"ack",
		)(fakeTheme(), 80);
		expect(lines.join("\n")).toContain("(review-level)");
	});

	it("labels file-level threads (path but no line)", () => {
		const lines = renderReplyGateContent(thread({ line: null }), "ack")(
			fakeTheme(),
			80,
		);
		const text = lines.join("\n");
		expect(text).toContain("src/foo.ts");
		expect(text).not.toContain("src/foo.ts:");
	});

	it("surfaces resolved + outdated flags", () => {
		const lines = renderReplyGateContent(
			thread({ isResolved: true, isOutdated: true }),
			"ack",
		)(fakeTheme(), 80);
		const text = lines.join("\n");
		expect(text).toContain("resolved");
		expect(text).toContain("outdated");
	});

	it("omits the flags line when none apply", () => {
		const lines = renderReplyGateContent(thread(), "ack")(fakeTheme(), 80);
		const text = lines.join("\n");
		expect(text).not.toContain("resolved");
		expect(text).not.toContain("outdated");
	});

	it("renders every comment on the thread, not just the first", () => {
		const lines = renderReplyGateContent(
			thread({
				comments: [
					{
						id: "C1",
						author: "alice",
						body: "first",
						createdAt: "2024-01-01T00:00:00Z",
						url: "u1",
					},
					{
						id: "C2",
						author: "bob",
						body: "second",
						createdAt: "2024-01-02T00:00:00Z",
						url: "u2",
					},
				],
			}),
			"ack",
		)(fakeTheme(), 80);
		const text = lines.join("\n");
		expect(text).toContain("@alice");
		expect(text).toContain("first");
		expect(text).toContain("@bob");
		expect(text).toContain("second");
	});

	it("renders multi-line reply bodies across multiple lines", () => {
		const lines = renderReplyGateContent(
			thread(),
			"Fixed in a1b2c3d.\nAlso added a regression test.",
		)(fakeTheme(), 80);
		const text = lines.join("\n");
		expect(text).toContain("Fixed in a1b2c3d.");
		expect(text).toContain("Also added a regression test.");
	});

	it("wraps long existing comments and reply text to the content width", () => {
		const lines = renderReplyGateContent(
			thread({
				comments: [
					{
						id: "C1",
						author: "octocat",
						body: "This existing comment is long enough to wrap inside the reply confirmation panel before the edge.",
						createdAt: "2024-01-01T00:00:00Z",
						url: "https://example.com/c1",
					},
				],
			}),
			"This proposed reply is also long enough to wrap inside the confirmation panel before posting.",
		)(fakeTheme(), 42);

		expect(lines.every((line) => visibleLength(line) <= 42)).toBe(true);
		expect(lines.some((line) => line.includes("@octocat:"))).toBe(true);
		expect(lines.some((line) => line.includes("before the edge"))).toBe(true);
		expect(lines.some((line) => line.includes("This proposed reply"))).toBe(
			true,
		);
		expect(lines.some((line) => line.includes("before posting"))).toBe(true);
	});
});

describe("renderResolveGateContent", () => {
	it("renders thread location, existing comment and resolution intent", () => {
		const lines = renderResolveGateContent(thread())(fakeTheme(), 80);
		const text = lines.join("\n");
		expect(text).toContain("src/foo.ts:10");
		expect(text).toContain("@octocat");
		expect(text).toContain("Could this be simpler?");
		expect(text).toContain("Mark thread resolved");
	});

	it("does NOT contain a proposed-reply section", () => {
		const lines = renderResolveGateContent(thread())(fakeTheme(), 80);
		expect(lines.join("\n")).not.toContain("Proposed reply");
	});

	it("surfaces resolved + outdated flags", () => {
		const lines = renderResolveGateContent(
			thread({ isResolved: true, isOutdated: true }),
		)(fakeTheme(), 80);
		const text = lines.join("\n");
		expect(text).toContain("resolved");
		expect(text).toContain("outdated");
	});

	it("labels PR-level threads when path is null", () => {
		const lines = renderResolveGateContent(thread({ path: null, line: null }))(
			fakeTheme(),
			80,
		);
		expect(lines.join("\n")).toContain("(PR-level)");
	});

	it("wraps long existing comments to the content width", () => {
		const lines = renderResolveGateContent(
			thread({
				comments: [
					{
						id: "C1",
						author: "octocat",
						body: "This resolve comment is long enough to wrap inside the confirmation panel before resolving.",
						createdAt: "2024-01-01T00:00:00Z",
						url: "https://example.com/c1",
					},
				],
			}),
		)(fakeTheme(), 42);

		expect(lines.every((line) => visibleLength(line) <= 42)).toBe(true);
		expect(lines.some((line) => line.includes("@octocat:"))).toBe(true);
		expect(lines.some((line) => line.includes("before resolving"))).toBe(true);
	});
});
