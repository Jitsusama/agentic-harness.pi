import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveVerifyExtensionPath } from "../../../extensions/pr-workflow/verify-path.js";

// The path-resolution helper exists so reviewer
// dispatchers can compute the sibling extension's entry
// point without rolling their own URL math. Test that
// it returns an absolute path that actually points at
// the sibling on disk: a regression here silently
// disables verify-output in every council subagent.

describe("resolveVerifyExtensionPath", () => {
	it("returns an absolute path to the sibling index.ts that exists on disk", () => {
		const path = resolveVerifyExtensionPath();
		expect(path.startsWith("/")).toBe(true);
		expect(path.endsWith("/pr-workflow-verify/index.ts")).toBe(true);
		expect(existsSync(path)).toBe(true);
	});
});
