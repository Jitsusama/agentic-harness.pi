import { describe, expect, it } from "vitest";
import { attributeGh } from "../../../extensions/attribution-interceptor/attribution.js";

function rewrittenCommand(command: string, entity: "pr" | "issue"): string {
	const result = attributeGh(command, entity, null);
	if (result.kind !== "rewritten") {
		throw new Error(`expected rewritten, got ${result.kind}`);
	}
	return result.command;
}

describe("attributeGh", () => {
	it("splices the footer into a heredoc pr body and keeps the delimiter", () => {
		const command =
			"gh pr create --title \"T\" --body-file - <<'EOF'\nThe body.\nEOF";
		const result = rewrittenCommand(command, "pr");
		expect(result).toContain("The body.");
		expect(result).toContain("Co-Authored-By AI");
		expect(result).toContain("<<'EOF'");
		expect(result).toContain("\nEOF");
	});

	it("leaves the leading cd and env assignment untouched", () => {
		const command =
			"cd /repo && GH_HOST=github.com gh pr create -R o/r --body-file - <<'EOF'\nThe body.\nEOF";
		const result = rewrittenCommand(command, "pr");
		expect(result).toContain("cd /repo &&");
		expect(result).toContain("GH_HOST=github.com");
		expect(result).toContain("-R o/r");
		expect(result).toContain("Co-Authored-By AI");
	});

	it("leaves shell tokens after the closing delimiter untouched", () => {
		const command =
			"gh pr create --title \"T\" --body-file - <<'EOF'\nThe body.\nEOF\n && git push";
		const result = rewrittenCommand(command, "pr");
		expect(result).toContain("Co-Authored-By AI");
		expect(result).toContain("&& git push");
	});

	it("leaves opener-line trailing tokens on a piped command untouched", () => {
		const command =
			"gh pr edit 42 --body-file - <<'EOF' 2>&1 | tail -5\nThe body.\nEOF";
		const result = rewrittenCommand(command, "pr");
		expect(result).toContain("Co-Authored-By AI");
		expect(result).toContain("<<'EOF' 2>&1 | tail -5\n");
	});

	it("attributes issue commands and keeps trailing tokens", () => {
		const command =
			"gh issue create --title \"T\" --body-file - <<'EOF'\nThe body.\nEOF\n && echo done";
		const result = rewrittenCommand(command, "issue");
		expect(result).toContain("Co-Authored-By AI");
		expect(result).toContain("&& echo done");
	});

	it("blocks a gh entity command in an unsupported shape", () => {
		const result = attributeGh(
			"x=$(gh pr create --body-file - <<'EOF'\nbody\nEOF\n)",
			"pr",
			null,
		);
		expect(result.kind).toBe("blocked");
	});
});
