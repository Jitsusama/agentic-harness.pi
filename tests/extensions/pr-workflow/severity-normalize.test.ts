import { describe, expect, it } from "vitest";
import {
	normalizeFindingSeverities,
	renderAliasNormalizationSummary,
} from "../../../extensions/pr-workflow/severity-normalize.js";

describe("renderAliasNormalizationSummary", () => {
	it("collapses case- and whitespace-different aliases into one entry", () => {
		// Without trim+lowercase keying, " High " and
		// "high" would hash to two different buckets and
		// the summary's lookup against the canonical map
		// would miss them both.
		const input = {
			findings: [
				{ subject: "a", severity: "high" },
				{ subject: "b", severity: " High " },
				{ subject: "c", severity: "HIGH" },
			],
		};
		const result = normalizeFindingSeverities(input);
		const summary = renderAliasNormalizationSummary(result.aliasCounts);
		expect(summary).toBe(
			"Normalized non-canonical severities: high→critical (×3).",
		);
	});

	it("returns null when no aliases were remapped", () => {
		const result = normalizeFindingSeverities({
			findings: [
				{ subject: "a", severity: "critical" },
				{ subject: "b", severity: "medium" },
			],
		});
		expect(renderAliasNormalizationSummary(result.aliasCounts)).toBeNull();
	});

	it("renders multiple distinct aliases in stable order", () => {
		const result = normalizeFindingSeverities({
			findings: [
				{ subject: "a", severity: "required" },
				{ subject: "b", severity: "required" },
				{ subject: "c", severity: "info" },
			],
		});
		const summary = renderAliasNormalizationSummary(result.aliasCounts);
		expect(summary).toContain("required→critical (×2)");
		expect(summary).toContain("info→minor (×1)");
	});
});
