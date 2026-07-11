import { describe, expect, it } from "vitest";
import {
	detectAmendViolation,
	detectCompoundViolation,
	detectUnquotedCommitHeredoc,
} from "../../../extensions/git-cli-interceptor/patterns.js";

describe("detectAmendViolation", () => {
	it("blocks git commit --amend", () => {
		expect(detectAmendViolation("git commit --amend -m x")).toMatch(
			/--amend is not allowed/,
		);
	});

	it("allows a plain commit and an unrelated amend-ish word", () => {
		expect(detectAmendViolation("git commit -m x")).toBeNull();
		expect(detectAmendViolation("git log --amend-nothing")).toBeNull();
	});
});

describe("detectUnquotedCommitHeredoc", () => {
	it("blocks a commit with an unquoted heredoc delimiter", () => {
		const cmd = "git commit -F - <<EOF\nsubject\nEOF";
		expect(detectUnquotedCommitHeredoc(cmd, cmd)).toMatch(/unquoted delimiter/);
	});

	it("allows a quoted heredoc delimiter", () => {
		const cmd = "git commit -F - <<'EOF'\nsubject\nEOF";
		expect(detectUnquotedCommitHeredoc(cmd, cmd)).toBeNull();
	});

	it("ignores an unquoted heredoc that is not feeding a commit", () => {
		const cmd = "cat <<EOF\nhi\nEOF";
		expect(detectUnquotedCommitHeredoc(cmd, cmd)).toBeNull();
	});
});

describe("detectCompoundViolation", () => {
	it("allows a bare staging prefix before a commit", () => {
		expect(detectCompoundViolation("git add -A && git commit -m x")).toBeNull();
	});

	it("blocks two guardable commands in one call", () => {
		expect(
			detectCompoundViolation("git commit -m x && gh pr create --body y"),
		).toMatch(/multiple guardable commands/);
	});

	it("blocks a state change chained with a guardable command", () => {
		expect(detectCompoundViolation("git commit -m x && git push")).toMatch(
			/state change chained/,
		);
	});

	it("allows a single command with no separators", () => {
		expect(detectCompoundViolation("git commit -m x")).toBeNull();
	});
});
