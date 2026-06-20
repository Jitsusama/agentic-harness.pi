import { describe, expect, it } from "vitest";
import { detectInlineBody } from "../../../extensions/github-cli-interceptor/patterns.js";

describe("detectInlineBody", () => {
	it("blocks an inline --body", () => {
		expect(detectInlineBody('gh pr create --body "x"')).not.toBeNull();
	});

	it("blocks the short -b form", () => {
		expect(detectInlineBody('gh pr create -b "x"')).not.toBeNull();
	});

	it("allows the body-file heredoc form", () => {
		expect(
			detectInlineBody("gh pr create --body-file - <<'EOF'\nx\nEOF"),
		).toBeNull();
	});

	it("ignores a command that is not gh pr/issue", () => {
		expect(detectInlineBody('git commit -m "x"')).toBeNull();
	});
});
