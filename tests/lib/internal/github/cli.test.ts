import { describe, expect, it } from "vitest";
import {
	parseIssueCommand,
	parsePrCommand,
} from "../../../../lib/internal/github/cli.js";

describe("parsePrCommand", () => {
	it("parses a title-only edit with a null body", () => {
		const parsed = parsePrCommand('gh pr edit 42 --title "Fix the Flaky Test"');
		expect(parsed).not.toBeNull();
		expect(parsed?.action).toBe("edit");
		expect(parsed?.title).toBe("Fix the Flaky Test");
		expect(parsed?.body).toBeNull();
		expect(parsed?.prNumber).toBe("42");
	});

	it("returns null for a metadata-only edit with no title and no body", () => {
		expect(parsePrCommand("gh pr edit 42 --add-label bug")).toBeNull();
	});
});

describe("parseIssueCommand", () => {
	it("parses a title-only edit with a null body", () => {
		const parsed = parseIssueCommand(
			'gh issue edit 7 --title "Track the Flaky Test"',
		);
		expect(parsed).not.toBeNull();
		expect(parsed?.title).toBe("Track the Flaky Test");
		expect(parsed?.body).toBeNull();
		expect(parsed?.issueNumber).toBe("7");
	});

	it("returns null for a metadata-only edit with no title and no body", () => {
		expect(parseIssueCommand("gh issue edit 7 --add-label bug")).toBeNull();
	});
});
