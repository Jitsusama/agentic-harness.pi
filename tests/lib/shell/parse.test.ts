import { describe, expect, it } from "vitest";
import { extractBody } from "../../../lib/shell/parse.js";

describe("extractBody", () => {
	it("returns the heredoc body when no content follows the delimiter", () => {
		const command = "gh pr create --body-file - <<'EOF'\nHello.\nEOF";
		expect(extractBody(command, command)).toBe("Hello.");
	});

	it("returns the heredoc body when shell tokens follow the closing delimiter", () => {
		const command =
			"gh pr create --body-file - <<'EOF'\nBody line one.\nBody line two.\nEOF\n && git push";
		expect(extractBody(command, command)).toBe(
			"Body line one.\nBody line two.",
		);
	});

	it("stops at the real closing delimiter when the body mentions other heredoc tokens", () => {
		const command =
			"gh pr edit --body-file - <<'EOF'\nSee the SYSTEMD_EOF heredoc below.\nMore body.\nEOF\n && echo done";
		expect(extractBody(command, command)).toBe(
			"See the SYSTEMD_EOF heredoc below.\nMore body.",
		);
	});

	it("falls back to the --body flag when there is no heredoc", () => {
		const command = 'gh pr create --body "Plain body."';
		expect(extractBody(command, command)).toBe("Plain body.");
	});
});
