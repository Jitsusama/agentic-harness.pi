import { describe, expect, it } from "vitest";
import {
	parseIssueCommand,
	parsePrCommand,
} from "../../../../lib/internal/github/cli.js";

const PR_BODY = "gh pr create --title \"A Title\" --body-file - <<'B'\nbody\nB";
const ISSUE_BODY =
	"gh issue create --title \"A Title\" --body-file - <<'B'\nbody\nB";

describe("parsePrCommand", () => {
	it("parses a title-only edit with a null body", () => {
		const parsed = parsePrCommand('gh pr edit 42 --title "Fix the Flaky Test"');
		expect(parsed).not.toBeNull();
		expect(parsed?.action).toBe("edit");
		expect(parsed?.title).toBe("Fix the Flaky Test");
		expect(parsed?.body).toBeNull();
		expect(parsed?.prNumber).toBe("42");
	});

	it("parses a body-only edit", () => {
		const parsed = parsePrCommand(
			"gh pr edit 42 --body-file - <<'B'\nnew body\nB",
		);
		expect(parsed?.body).toBe("new body");
		expect(parsed?.title).toBeNull();
	});

	it("parses a create that carries a body", () => {
		expect(parsePrCommand(PR_BODY)?.action).toBe("create");
	});

	it("returns null for a title-only create with no body", () => {
		// A bodyless create stays ungated, unchanged: the title-only
		// allowance is scoped to edits so creates still owe a body to
		// the section gate.
		expect(
			parsePrCommand('gh pr create --title "A Bodyless Create"'),
		).toBeNull();
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

	it("parses a create that carries a body", () => {
		expect(parseIssueCommand(ISSUE_BODY)?.action).toBe("create");
	});

	it("returns null for a title-only create with no body", () => {
		expect(
			parseIssueCommand('gh issue create --title "A Bodyless Create"'),
		).toBeNull();
	});

	it("returns null for a metadata-only edit with no title and no body", () => {
		expect(parseIssueCommand("gh issue edit 7 --add-label bug")).toBeNull();
	});
});
