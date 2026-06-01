import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	injectCommitAttribution,
	injectGhAttribution,
} from "../../../extensions/attribution-interceptor/attribution.js";

describe("injectCommitAttribution", () => {
	it("reads a -F <file>, translates it to a heredoc and attributes it", () => {
		const dir = mkdtempSync(join(tmpdir(), "attr-commit-"));
		const path = join(dir, "msg.txt");
		writeFileSync(path, "feat: do the thing\n\nThe body explains why.\n");
		const result = injectCommitAttribution(
			`git commit -F ${path} 2>&1 | tail -3`,
			null,
		);
		expect(result).not.toBeNull();
		expect(result).toContain("feat: do the thing");
		expect(result).toContain("The body explains why.");
		expect(result).toContain("-F- <<'__COMMIT_MSG__'");
		expect(result).toContain("Co-Authored-By: AI");
	});

	it("leaves a -F <file> alone when the file cannot be read", () => {
		expect(
			injectCommitAttribution("git commit -F /nonexistent/msg.txt", null),
		).toBeNull();
	});
});

describe("injectGhAttribution", () => {
	it("injects the footer for a plain heredoc pr command", () => {
		const command =
			"gh pr create --title \"T\" --body-file - <<'EOF'\nThe body.\nEOF";
		const result = injectGhAttribution(command, "pr", null);
		expect(result).not.toBeNull();
		expect(result).toContain("The body.");
		expect(result).toContain("Co-Authored-By AI");
	});

	it("preserves shell tokens after the closing delimiter", () => {
		const command =
			"gh pr create --title \"T\" --body-file - <<'EOF'\nThe body.\nEOF\n && git push";
		const result = injectGhAttribution(command, "pr", null);
		expect(result).not.toBeNull();
		expect(result).toContain("Co-Authored-By AI");
		expect(result).toContain("&& git push");
	});

	it("preserves opener-line trailing tokens on a piped command", () => {
		const command =
			"gh pr edit 42 --body-file - <<'EOF' 2>&1 | tail -5\nThe body.\nEOF";
		const result = injectGhAttribution(command, "pr", null);
		expect(result).not.toBeNull();
		expect(result).toContain("Co-Authored-By AI");
		expect(result).toContain("The body.");
		// The redirect-and-pipe must stay on the opener line, right
		// after the heredoc delimiter, or it would be a syntax error.
		expect(result).toContain("<<'__PR_BODY__' 2>&1 | tail -5\n");
	});

	it("preserves trailing tokens for issue commands too", () => {
		const command =
			"gh issue create --title \"T\" --body-file - <<'EOF'\nThe body.\nEOF\n && echo done";
		const result = injectGhAttribution(command, "issue", null);
		expect(result).not.toBeNull();
		expect(result).toContain("&& echo done");
	});
});
