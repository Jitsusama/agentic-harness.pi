import { describe, expect, it } from "vitest";
import { insertGhBodyFooter } from "../../../../lib/internal/github/attribution-edit.js";

const FOOTER = "\n\n---\nattributed";
const never = () => false;

describe("insertGhBodyFooter", () => {
	it("splices the footer into a heredoc body without touching cd, env or -R", () => {
		const source = [
			"cd /repo/src && GH_HOST=github.com gh pr create -R shop/world \\",
			"  --title \"My PR\" --body-file - <<'EOF'",
			"Initial body.",
			"EOF",
		].join("\n");

		const result = insertGhBodyFooter(source, "pr", FOOTER, never);

		expect(result.kind).toBe("rewritten");
		if (result.kind !== "rewritten") return;
		expect(result.command).toContain("cd /repo/src &&");
		expect(result.command).toContain("GH_HOST=github.com");
		expect(result.command).toContain("-R shop/world");
		expect(result.command).toContain("Initial body.\n\n---\nattributed\nEOF");
	});

	it("inserts into an inline double-quoted body before the closing quote", () => {
		const source = 'gh pr create -R shop/world --body "Hello there"';

		const result = insertGhBodyFooter(source, "pr", FOOTER, never);

		expect(result.kind).toBe("rewritten");
		if (result.kind !== "rewritten") return;
		expect(result.command).toBe(
			'gh pr create -R shop/world --body "Hello there\n\n---\nattributed"',
		);
	});

	it("blocks an unquoted inline body it cannot splice safely", () => {
		const result = insertGhBodyFooter(
			"gh pr create --body plain",
			"pr",
			FOOTER,
			never,
		);

		expect(result.kind).toBe("blocked");
	});

	it("skips a body that is already attributed", () => {
		const source = "gh pr create --body-file - <<'EOF'\nbody\nEOF";

		const result = insertGhBodyFooter(source, "pr", FOOTER, () => true);

		expect(result.kind).toBe("skip");
	});

	it("blocks a gh entity command in an unsupported shape", () => {
		const source = "x=$(gh pr create --body-file - <<'EOF'\nbody\nEOF\n)";

		const result = insertGhBodyFooter(source, "pr", FOOTER, never);

		expect(result.kind).toBe("blocked");
	});

	it("skips a command that is not a gh entity command", () => {
		expect(insertGhBodyFooter("git status", "pr", FOOTER, never).kind).toBe(
			"skip",
		);
	});
});
