/**
 * Judging whether the server render survived hydration.
 */

import { describe, expect, it } from "vitest";
import type { HydrationCapture } from "../../../../lib/core/web/hydration/capture.ts";
import {
	judgeHydration,
	renderHydration,
	SHELL_MIN_CLIENT_TEXTS,
	TAG_DRIFT_MIN,
} from "../../../../lib/core/web/hydration/judge.ts";

const TEXTS = [
	"Welcome to the page",
	"A paragraph of honest server content",
	"Another paragraph that hydrates cleanly",
	"A fourth block of text",
	"A fifth block of text",
	"A sixth block of text",
];

const capture = (over: Partial<HydrationCapture> = {}): HydrationCapture => ({
	url: "https://example.test/",
	fetched: true,
	status: 200,
	serverTexts: TEXTS,
	clientTexts: TEXTS,
	serverTags: { div: 10, p: 6 },
	clientTags: { div: 10, p: 6 },
	...over,
});

describe("judgeHydration", () => {
	it("passes when both renders agree", () => {
		const report = judgeHydration(capture());
		expect(report.standing).toBe("pass");
		expect(report.vanished).toEqual([]);
		expect(report.appeared).toEqual([]);
	});

	it("fails when server content vanished", () => {
		const report = judgeHydration(capture({ clientTexts: TEXTS.slice(1) }));
		expect(report.standing).toBe("fail");
		expect(report.vanished).toEqual(["Welcome to the page"]);
	});

	it("warns when content only exists after hydration", () => {
		// A client-only widget is legitimate, and this cannot tell
		// it from a bug, so it is a warning rather than a failure.
		const report = judgeHydration(
			capture({ clientTexts: [...TEXTS, "Client-only banner"] }),
		);
		expect(report.standing).toBe("warn");
		expect(report.appeared).toEqual(["Client-only banner"]);
	});

	it("counts repeated texts as a multiset, not a set", () => {
		// Three identical cards on the server and two after hydration
		// is a vanished card; a set comparison would call it a match.
		const report = judgeHydration(
			capture({
				serverTexts: [...TEXTS, "Card", "Card", "Card"],
				clientTexts: [...TEXTS, "Card", "Card"],
			}),
		);
		expect(report.vanished).toEqual(["Card"]);
	});

	it("fails on the framework's own hydration complaint", () => {
		const report = judgeHydration(capture(), [
			{ level: "error", text: "Hydration failed because the initial UI..." },
		]);
		expect(report.standing).toBe("fail");
		expect(report.warnings).toHaveLength(1);
	});

	it("recognizes the older wording too", () => {
		const report = judgeHydration(capture(), [
			{
				level: "warning",
				text: "Text content does not match server-rendered HTML",
			},
		]);
		expect(report.warnings).toHaveLength(1);
	});

	it("ignores hydration words said at log level", () => {
		// A page talking about hydration is not a page failing it.
		const report = judgeHydration(capture(), [
			{ level: "log", text: "hydration complete in 20ms" },
		]);
		expect(report.warnings).toEqual([]);
		expect(report.standing).toBe("pass");
	});

	it("reports tag drift past the noise floor", () => {
		const report = judgeHydration(
			capture({ clientTags: { div: 10 + TAG_DRIFT_MIN, p: 6 } }),
		);
		expect(report.standing).toBe("warn");
		expect(report.drift[0]?.tag).toBe("div");
	});

	it("leaves tag churn under the floor alone", () => {
		const report = judgeHydration(
			capture({ clientTags: { div: 10 + TAG_DRIFT_MIN - 1, p: 6 } }),
		);
		expect(report.drift).toEqual([]);
	});

	it("calls a client-rendered page a shell, not a mismatch", () => {
		const report = judgeHydration(
			capture({
				serverTexts: [],
				clientTexts: Array.from(
					{ length: SHELL_MIN_CLIENT_TEXTS },
					(_, index) => `Client text ${index}`,
				),
			}),
		);
		expect(report.shell).toBe(true);
		expect(report.standing).toBe("warn");
		expect(report.appeared).toEqual([]);
	});

	it("warns rather than judging when the fetch failed", () => {
		const report = judgeHydration(capture({ fetched: false }));
		expect(report.standing).toBe("warn");
		expect(report.vanished).toEqual([]);
	});

	it("still fails an unfetched capture when the console complained", () => {
		const report = judgeHydration(capture({ fetched: false }), [
			{ level: "error", text: "An error occurred during hydration" },
		]);
		expect(report.standing).toBe("fail");
	});
});

describe("renderHydration", () => {
	it("passes plainly when the renders agree", () => {
		const out = renderHydration(judgeHydration(capture()));
		expect(out.startsWith("PASS")).toBe(true);
	});

	it("names the vanished content", () => {
		const out = renderHydration(
			judgeHydration(capture({ clientTexts: TEXTS.slice(1) })),
		);
		expect(out.startsWith("FAIL")).toBe(true);
		expect(out).toContain('"Welcome to the page"');
	});

	it("warns about volatile content in the measured line", () => {
		// Two fetches of a page that renders the time will differ;
		// the reader has to be told before trusting a paired
		// vanish-and-appear.
		const out = renderHydration(judgeHydration(capture()));
		expect(out).toContain("renders the time");
	});

	it("says why a shell is not a pass", () => {
		const out = renderHydration(
			judgeHydration(
				capture({
					serverTexts: [],
					clientTexts: Array.from(
						{ length: SHELL_MIN_CLIENT_TEXTS },
						(_, index) => `Client text ${index}`,
					),
				}),
			),
		);
		expect(out.startsWith("WARN")).toBe(true);
		expect(out).toContain("client-rendered");
	});

	it("says what the failed fetch answered", () => {
		const out = renderHydration(
			judgeHydration(capture({ fetched: false, status: 403 })),
		);
		expect(out).toContain("403");
	});
});
