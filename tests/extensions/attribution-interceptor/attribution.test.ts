import { describe, expect, it } from "vitest";
import { injectGhAttribution } from "../../../extensions/attribution-interceptor/attribution.js";

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
