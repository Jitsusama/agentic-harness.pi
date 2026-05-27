import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveVerifyPack } from "../../../extensions/pr-workflow/verify-packs";

// The verify-pack resolver is what wires reviewer
// subagents to their per-stage `verify_output` tool and
// output-contract skill. A regression here silently
// disables self-verify, so we exercise the happy path
// (every known stage resolves to existing files), the
// explicit-opt-out path (undefined stage returns
// undefined) and the fail-closed path (any other
// unrecognized stage throws rather than silently
// disabling verification).

describe("resolveVerifyPack", () => {
	const stages = [
		"council",
		"judge",
		"critique",
		"stack-review",
		"stack-judge",
	] as const;

	for (const stage of stages) {
		it(`resolves the ${stage} pack to existing files`, () => {
			const pack = resolveVerifyPack(stage);
			expect(pack).toBeDefined();
			if (!pack) return;
			expect(pack.extensionPath.startsWith("/")).toBe(true);
			expect(pack.extensionPath).toMatch(
				new RegExp(`/lib/internal/pr-workflow-verify/packs/${stage}\\.ts$`),
			);
			expect(existsSync(pack.extensionPath)).toBe(true);
			expect(pack.skillPath).toBeDefined();
			expect(
				pack.skillPath?.endsWith(`/pr-workflow-${stage}-output/SKILL.md`),
			).toBe(true);
			if (pack.skillPath) expect(existsSync(pack.skillPath)).toBe(true);
		});
	}

	it("returns undefined only when no stage is requested", () => {
		// The engine treats `undefined` as "no verification
		// required"; callers that genuinely don't want
		// self-verify omit the stage. Any other input is a
		// programmer or config error.
		expect(resolveVerifyPack(undefined)).toBeUndefined();
	});

	it("throws for any other unrecognized stage", () => {
		// Returning undefined for a typo would silently
		// disable verification at the safety boundary.
		// Failing closed forces the caller to fix the
		// stage string rather than ship an unverified
		// reviewer run.
		expect(() => resolveVerifyPack("counsel")).toThrow(
			/Unknown pr-workflow verification stage "counsel"/,
		);
		expect(() => resolveVerifyPack("stack-critic")).toThrow(
			/Unknown pr-workflow verification stage "stack-critic"/,
		);
	});
});
