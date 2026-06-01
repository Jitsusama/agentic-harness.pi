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

	it("preserves trailing tokens for issue commands too", () => {
		const command =
			"gh issue create --title \"T\" --body-file - <<'EOF'\nThe body.\nEOF\n && echo done";
		const result = injectGhAttribution(command, "issue", null);
		expect(result).not.toBeNull();
		expect(result).toContain("&& echo done");
	});
});
